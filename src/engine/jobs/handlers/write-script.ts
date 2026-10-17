// The `write_script` stage handler (contract v8, Video Engine Bible section 4 v8 note, Bible 6.2 and 6.3). A brief request has no
// script: this stage writes one from the brief, its sources and attachment notes, and the structure of the analysed reference (its
// VideoDNA: genome, transferable genes, beat structure and durations). It runs after analyze_reference and before voice, and only for
// a brief. A script request skips it (the orchestrator marks it done at the start).
//
// The writer is the scriptwriter role (claude/roles/scriptwriter.ts, Opus), called through runRole on the job's reservation, so the call
// is ledgered and journaled. Its answer contract refuses copied runs of the reference's words, a script over maxMs, a forbidden term and
// an unknown source label, and the single retry names those checks. The stage then checks the result against the written_script contract
// and against the format minimum: the budget must cover the cheapest plan for the written beats (intake could not compute it before the
// script existed). A failure fails the stage with its reason; no script is stored and nothing is guessed.
//
// Every failure is an EngineError with its reason. A stage that cannot run because its kits or its voice are not loaded throws a config
// error before any call.

import { runRole, type RoleDeps } from "../../claude/client.ts";
import { scriptwriter, type ScriptwriterAnswer, type ScriptwriterInput } from "../../claude/roles/scriptwriter.ts";
import {
  EngineError,
  productionRequestSchema,
  videoDnaSchema,
  writtenScriptSchema,
  type ArtifactType,
  type ProductionRequest,
  type VideoDNA,
  type WrittenScript,
} from "../../contracts/index.ts";
import { minimumMasterBudgetUsd, planKitsOf } from "../../plan/minimum.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";
import type { KitScope, ResolvedKits } from "./intake.ts";

export const WRITE_SCRIPT_STAGE = "write_script";

/** The ports of the stage: the kit store (the same port intake uses) and the Claude client's deps for one request's reservation. */
export type WriteScriptPorts = {
  loadKits: (scope: KitScope) => Promise<ResolvedKits>;
  roleDeps: (scope: { organizationId: string; requestId: string; reservationId: string }) => RoleDeps;
};

function refuse(message: string): EngineError {
  return new EngineError("invalid_input", message, { stage: WRITE_SCRIPT_STAGE });
}

/** The one input artifact of a type. An input that is not of that type is skipped; none of the type is refused. */
function oneOf(stored: readonly StoredArtifact[], type: ArtifactType): StoredArtifact {
  const matches = stored.filter((artifact) => artifact.envelope.type === type);
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) throw refuse(`write_script needs exactly one ${type} input, and it has ${matches.length}`);
  return only;
}

/** The job's infrastructure attempt (Bible 5.1), from 1. An unreadable attempt is refused. */
function attemptNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw refuse(`the job attempt ${value} is not a whole number from 1`);
  return parsed;
}

/** The inputs of the writer: the brief, the reference's structure, the words per minute and the claims the product approves. */
function writerInputOf(input: {
  request: ProductionRequest;
  dna: VideoDNA;
  wordsPerMinute: number;
  claims: string[];
  forbidden: string[];
}): ScriptwriterInput {
  const brief = input.request.brief;
  if (brief === undefined) throw refuse("write_script runs for a brief request, and this request has no brief");
  return {
    brief: {
      text: brief.text,
      sources: brief.sources.map((source) => ({ label: source.label, text: source.text })),
      attachments: brief.attachments.map((attachment) => ({
        mediaType: attachment.mediaType,
        ...(attachment.note === undefined ? {} : { note: attachment.note }),
      })),
    },
    reference: {
      videoDnaId: input.dna.videoDnaId,
      durationMs: input.dna.durationMs,
      genome: input.dna.genome,
      transferable: input.dna.transferable,
      notTransferable: input.dna.notTransferable,
      segments: input.dna.segments.map((segment) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        shotType: segment.shotType,
        ...(segment.beatRole === undefined ? {} : { beatRole: segment.beatRole }),
      })),
    },
    transcript: input.dna.transcript.words,
    constraints: { maxMs: input.request.constraints.maxMs, wordsPerMinute: input.wordsPerMinute },
    claims: input.claims,
    forbidden: input.forbidden,
    // The reference's speech language (the DNA transcript's): the writer's language when the brief states none (contract v8, lead 2026-10-17).
    referenceLanguage: input.dna.transcript.language ?? null,
  };
}

/** The write_script stage. Pass the ports the worker wires. A script request is refused: its script is its own. */
export function createWriteScriptHandler(ports: WriteScriptPorts): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const reservationId = ctx.payload.budgetReservationId;
      if (reservationId === null) {
        throw new EngineError("conflict", "write_script is a paid stage and needs a budget reservation on the request", { stage: ctx.stage });
      }
      const stored: StoredArtifact[] = [];
      for (const artifactId of ctx.payload.inputArtifactIds) {
        stored.push(await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId }));
      }
      const requestStored = oneOf(stored, "production_request");
      const dnaStored = oneOf(stored, "video_dna");
      const requestParsed = productionRequestSchema.safeParse(requestStored.envelope.body);
      const dnaParsed = videoDnaSchema.safeParse(dnaStored.envelope.body);
      if (!requestParsed.success || !dnaParsed.success) {
        throw new EngineError("internal", "the write_script inputs do not parse: the production request or the video DNA", { stage: ctx.stage });
      }
      const request = requestParsed.data;
      const dna = dnaParsed.data;
      if (request.script !== undefined || request.brief === undefined) {
        throw refuse("write_script writes the script of a brief request; this request sends its own script, so it is not run");
      }

      const kits = await ports.loadKits({ organizationId: ctx.organizationId, request });
      const wordsPerMinute = kits.persona?.wordsPerMinute ?? kits.voice?.wordsPerMinute;
      if (wordsPerMinute === undefined) {
        throw new EngineError(
          "config",
          `NOT_CONNECTED: voice ${request.page.voiceId} has no words per minute, because neither its persona nor its voice kit loaded; the script's length cannot be checked, so no call is made`,
          { stage: ctx.stage },
        );
      }
      const product = request.product;
      if (product !== undefined && kits.productKit === undefined) {
        throw new EngineError("config", `the product kit ${product.productKitId} did not load, so the claims cannot be checked; no call is made`, {
          stage: ctx.stage,
        });
      }
      const claims = (kits.productKit?.approvedClaims ?? [])
        .filter((claim) => product?.claimIds.includes(claim.claimId) ?? false)
        .map((claim) => claim.text);
      const forbidden = kits.productKit?.forbidden ?? [];

      const deps = ports.roleDeps({ organizationId: ctx.organizationId, requestId: ctx.requestId, reservationId });
      const outcome = await runRole(deps, scriptwriter, {
        requestId: ctx.requestId,
        workspaceId: ctx.organizationId,
        reservationId,
        attempt: attemptNumber(ctx.payload.attempt),
        signal: ctx.signal,
        input: writerInputOf({ request, dna, wordsPerMinute, claims, forbidden }),
      });
      if (outcome.status === "refused") {
        throw new EngineError("conflict", `the budget refused the scriptwriter call: ${outcome.reason}`, { stage: ctx.stage });
      }
      if (outcome.status === "duplicate") {
        throw new EngineError(
          "conflict",
          "the scriptwriter was already authorized for this job and no answer is stored; reuse the stored answer, no call is made",
          { stage: ctx.stage },
        );
      }
      const answer: ScriptwriterAnswer = outcome.value;

      const written: WrittenScript = {
        schema: "meridian.written_script/v1",
        requestId: ctx.requestId,
        language: answer.language,
        beats: answer.beats,
        rationale: answer.rationale,
        basedOn: { videoDnaId: dna.videoDnaId, sourceLabels: answer.sourceLabels },
      };
      const parsed = writtenScriptSchema.safeParse(written);
      if (!parsed.success) {
        throw new EngineError("internal", `the written script does not match its contract: ${parsed.error.issues[0]?.message ?? "unknown"}`, {
          stage: ctx.stage,
        });
      }

      // The format minimum (Bible 6.1 step 6), for the written beats: no visual requests (a brief sends none), so the minimum is the
      // fixed lines and the cheapest shot of every beat. A budget below it fails the stage with the minimum as its reason.
      const minimum = minimumMasterBudgetUsd({
        beats: parsed.data.beats,
        wordsPerMinute,
        visualRequests: [],
        classifications: [],
        kits: planKitsOf(kits),
      });
      if (minimum.minimumUsd > request.constraints.budgetUsd) {
        throw refuse(
          `the request budget ${request.constraints.budgetUsd} USD is below the format minimum of ${minimum.minimumUsd} USD for the written script`,
        );
      }

      const artifactId = (
        await writeArtifact(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "written_script",
          body: parsed.data,
          parentIds: [requestStored.envelope.artifactId, dnaStored.envelope.artifactId],
          createdAt: new Date().toISOString(),
        })
      ).artifactId;
      return {
        kind: "done",
        output: { stage: "write_script", subjectId: ctx.subjectId, artifacts: { script: artifactId } },
      };
    },
  };
}
