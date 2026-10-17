// The `voice` stage handler (Bible 6.3, gate voice 12.1). It reads the production_request artifact (its only input, Bible 5.1),
// loads the page's voice kit and the request's approved claims through ports, runs the voice stage (voice/voice.ts), and writes
// the voice_track artifact when the voice gate passes. A failing gate writes nothing: the orchestrator routes the failure.
//
// A stage that cannot run because a service is not connected throws a config error whose message starts with NOT_CONNECTED. The
// connections are checked before the first paid call, so the job is dead with that reason and nothing was spent.

import {
  EngineError,
  productionRequestSchema,
  type ArtifactType,
  type ProductionRequest,
  type VoiceKit,
} from "../../contracts/index.ts";
import { runVoice, VOICE_STAGE, type VoicePorts } from "../../voice/voice.ts";
import { NOT_CONNECTED, notConnectedReason } from "../../media/stt-connection.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import { scriptOf, writtenScriptOf } from "../../script/resolve.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

/** The ports of the voice stage: the voice stage's ports, and the kit and claim stores it reads. */
export type VoiceStagePorts = VoicePorts & {
  /** The page's voice kit, by voice id. Null when the kit is not found; not wired is refused as NOT_CONNECTED. */
  voiceKit?: (organizationId: string, voiceId: string) => Promise<VoiceKit | null>;
  /** The approved claim texts the request may make (the product kit's claims for claimIds). Absent means none. */
  claims?: (organizationId: string, request: ProductionRequest) => Promise<string[]>;
};

/** The voice ports of one job, built for its reservation (the router and the Claude deps are per reservation in production). */
export type VoicePortsFor = (scope: { organizationId: string; requestId: string; reservationId: string }) => VoiceStagePorts;

/** Every input artifact of the job, read (Bible 5.1). */
async function allInputs(ctx: StageContext): Promise<StoredArtifact[]> {
  const stored: StoredArtifact[] = [];
  for (const artifactId of ctx.payload.inputArtifactIds) {
    stored.push(await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId }));
  }
  return stored;
}

/** The one input artifact of a type. An input that is not of that type is skipped; none of the type is refused. */
async function readInputOfType(ctx: StageContext, type: ArtifactType): Promise<StoredArtifact> {
  for (const artifactId of ctx.payload.inputArtifactIds) {
    const stored = await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId });
    if (stored.envelope.type === type) return stored;
  }
  throw new EngineError(
    "invalid_input",
    `${ctx.stage} needs its ${type} input artifact, and none of its inputs is one`,
    { stage: ctx.stage },
  );
}

function attemptNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new EngineError(
      "invalid_input",
      `the job attempt ${value} is not a whole number from 1`,
      { stage: VOICE_STAGE },
    );
  }
  return parsed;
}

/**
 * The voice stage. Pass the ports the worker wires, or a function that builds them for the job's reservation (production: the router
 * and the Claude deps are per reservation). A port that is absent fails closed with NOT_CONNECTED.
 */
export function createVoiceHandler(portsOrFor: VoiceStagePorts | VoicePortsFor): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const reservationId = ctx.payload.budgetReservationId;
      if (reservationId === null) {
        throw new EngineError(
          "conflict",
          "voice is a paid stage and needs a budget reservation on the request",
          { stage: ctx.stage },
        );
      }
      const ports =
        typeof portsOrFor === "function"
          ? portsOrFor({ organizationId: ctx.organizationId, requestId: ctx.requestId, reservationId })
          : portsOrFor;
      const stored = await readInputOfType(ctx, "production_request");
      const parsed = productionRequestSchema.safeParse(stored.envelope.body);
      if (!parsed.success) {
        throw new EngineError(
          "internal",
          `the production request artifact does not parse: ${parsed.error.message}`,
          { stage: ctx.stage },
        );
      }
      const request = parsed.data;
      // The words to speak: the request's script, or a brief's written script (contract v8). A brief whose script is not written yet
      // is an internal error (script/resolve.ts), so voice never speaks an empty or guessed script.
      const script = scriptOf(request, writtenScriptOf(await allInputs(ctx), ctx.requestId));
      if (ports.voiceKit === undefined) {
        throw new EngineError(
          "config",
          notConnectedReason(
            `the voice kit ${request.page.voiceId} cannot be loaded: no voice kit store is connected`,
          ),
          { stage: ctx.stage },
        );
      }
      const kit = await ports.voiceKit(ctx.organizationId, request.page.voiceId);
      if (kit === null) {
        throw new EngineError(
          "config",
          `the voice kit ${request.page.voiceId} is not found in this workspace`,
          { stage: ctx.stage },
        );
      }
      const claims =
        ports.claims === undefined ? [] : await ports.claims(ctx.organizationId, request);

      const outcome = await runVoice(
        {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          reservationId,
          attempt: attemptNumber(ctx.payload.attempt),
          subjectId: ctx.subjectId,
          request,
          script,
          voice: kit,
          claims,
        },
        ports,
      );
      if (outcome.status === "not_connected") {
        const reason = outcome.reason.startsWith(NOT_CONNECTED)
          ? outcome.reason
          : notConnectedReason(outcome.reason);
        throw new EngineError("config", reason, { stage: ctx.stage });
      }
      const artifacts: Record<string, string> = {};
      if (outcome.gate.pass && outcome.track !== null) {
        const written = await writeArtifact(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "voice_track",
          body: outcome.track,
          parentIds: [stored.envelope.artifactId],
          createdAt: ports.roles.now(),
        });
        artifacts.voice = written.artifactId;
      }
      return {
        kind: "done",
        output: { stage: "voice", subjectId: ctx.subjectId, artifacts, gate: outcome.gate },
      };
    },
  };
}
