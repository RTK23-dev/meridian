// The `produce_shot` stage (Video Engine Bible 6.6, 10.4, 15.2). It makes one take for one shot and writes the Take artifact.
//
// Source kinds. A generate shot goes to the asset router: one paid call, against the request's reservation. A stock shot is searched
// through the stock routes (free, Bible 10.3), and the clip is downloaded through the gateway. A component or asset shot has no
// produce job; the orchestrator never queues one for it.
//
// Holds, not failures (Bible 5.1, 10.4). A budget refusal pauses the request with its reason. A content_policy or invalid_input
// refusal returns a hold with a rule-style hint, for the planner's one rewrite. Anything else that stops a take (no connected
// provider, every candidate failed, a full bucket, a duplicate call) is thrown: the job retries, and when it is dead the request
// pauses with its artifacts. Nothing is reported as a take that was not made.
//
// Output (Bible 6.6 step 4, with a limit). The file is downloaded, checked to be an mp4, probed, and kept only when it is H.264 at
// 1080 x 1920 with a known duration. Normalisation (6.6 step 4) needs a media function that is not built, so a file of another shape
// is a refusal (invalid_output), not a take that would fail later.
//
// Asynchronous providers (Bible 15.2). When the generator returns "submitted", run() returns submitted and the poller settles the
// call through finish(). The router in this repository is synchronous; its submit-only path is a W5 change (see STATUS.md).

import { EngineError, assetSpecSchema, contentHash, newId, scenePlanSchema, takeSchema, type AssetSpec, type Decision, type ProviderError, type ShotSpec, type Take } from "../../contracts/index.ts";
import type { ProviderPoll } from "../../contracts/assets.ts";
import type { AssetRouter, ProduceReport } from "../../assets/router.ts";
import type { StockOutcome } from "../../assets/stock.ts";
import type { MediaDownloader } from "../../gateway/download.ts";
import type { MediaFunctions, ProbeResult } from "../../media/interface.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";
import { FFMPEG_LIMITS } from "../../../../functions/ffmpeg/limits.ts";
import { thresholds } from "../../config/thresholds.ts";
import { mediaKey, readJobInputs, writeArtifact, type MediaStorePort } from "../artifact-store.ts";
import { stableId, seedFor } from "../stable-id.ts";
import { epochOf, type ProduceHold, type StageContext, type StageHandler, type StageOutput, type StageRunResult } from "../types.ts";

/** The stock route's endpoint family (config/routes.ts, "stock"). It names the call, not a model. */
export const STOCK_MODEL = "videos";

/** Stock search is free: list price 0 in config/prices.ts for pexels and pixabay. Stored as 0, not as an unknown. */
export const STOCK_COST_USD = 0;

/** The largest file a take may be (the media functions' input limit). */
export const TAKE_MAX_BYTES = FFMPEG_LIMITS.maxInputBytes;

/** The frame size a take must be stored at (Bible section 1). */
export const TAKE_WIDTH = 1080;
export const TAKE_HEIGHT = 1920;

/** A hint is a rule-style name written by this code. Anything else is dropped before it reaches a prompt (Bible 1). */
const HINT_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

/** What the router (or another generator) reports for one generate call. Every case is a fact about the call. */
export type ShotProduction =
  | {
      status: "done";
      providerId: string;
      uri: string;
      mediaType: string | null;
      costUsd: number;
      costIsEstimate: boolean;
      cacheHit: boolean;
      ledgerEntryId: string | null;
      decisions: Decision[];
    }
  | { status: "submitted"; providerId: string; jobRef: string; submittedAt: string; decisions: Decision[] }
  | { status: "failed"; providerId: string; error: ProviderError; decisions: Decision[] }
  | { status: "refused"; reasons: string[]; decisions: Decision[] }
  | { status: "queued"; reasons: string[] }
  | { status: "unavailable"; reasons: string[]; decisions: Decision[] }
  | { status: "not_connected"; reasons: string[] }
  | { status: "duplicate"; providerId: string; ledgerEntryId: string };

export type GenerateInput = {
  sql: Sql;
  organizationId: string;
  requestId: string;
  reservationId: string;
  spec: AssetSpec;
  visualType: string;
};

/** Makes the generated take. A generator that submits asynchronously implements settle as well (the poller calls it). */
export interface ShotGenerator {
  generate(input: GenerateInput): Promise<ShotProduction>;
  settle?(input: GenerateInput, polled: ProviderPoll, submission: { providerId: string; jobRef: string; submittedAt: string }): Promise<ShotProduction>;
}

export type StockSearch = (input: { organizationId: string; query: string; minDurationMs: number }) => Promise<StockOutcome>;

export type ProduceShotPorts = {
  generator: ShotGenerator;
  stock: StockSearch;
  downloader: MediaDownloader;
  /** Only probe is used here. */
  media: Pick<MediaFunctions, "probe">;
  /** Object storage for the take's media (Bible 5.2). */
  objects: MediaStorePort;
  now?: () => number;
};

/** Turns a router report into a ShotProduction. The router's facts are kept; nothing is inferred. */
export function productionFromReport(report: ProduceReport): ShotProduction {
  const outcome = report.outcome;
  const decisions = report.decisions;
  switch (outcome.status) {
    case "done":
      return {
        status: "done",
        providerId: outcome.asset.providerId,
        uri: outcome.asset.uri,
        mediaType: outcome.asset.mediaType,
        costUsd: outcome.asset.costUsd,
        costIsEstimate: outcome.asset.costIsEstimate,
        cacheHit: outcome.asset.cacheHit,
        ledgerEntryId: outcome.asset.ledgerEntryId,
        decisions,
      };
    case "failed":
      return { status: "failed", providerId: outcome.providerId, error: outcome.error, decisions };
    case "refused":
      return { status: "refused", reasons: outcome.reasons, decisions };
    case "queued":
      return { status: "queued", reasons: outcome.reasons };
    case "duplicate":
      return { status: "duplicate", providerId: outcome.providerId, ledgerEntryId: outcome.ledgerEntryId };
    case "not_connected":
      return { status: "not_connected", reasons: outcome.reasons };
    case "unavailable":
      return { status: "unavailable", reasons: outcome.reasons, decisions };
  }
}

/** The generator that runs the asset router. Synchronous: a call finishes inside the router, so it never returns submitted. */
export function routerGenerator(routerFor: (input: { sql: Sql; organizationId: string; requestId: string; reservationId: string }) => AssetRouter): ShotGenerator {
  return {
    async generate(input) {
      const router = routerFor({ sql: input.sql, organizationId: input.organizationId, requestId: input.requestId, reservationId: input.reservationId });
      const report = await router.produce({
        spec: input.spec,
        workspaceId: input.organizationId,
        requestId: input.requestId,
        reservationId: input.reservationId,
        stage: "produce_shot",
        visualType: input.visualType,
        continuityProvider: null,
        voiceId: null,
      });
      return productionFromReport(report);
    },
  };
}

/** The prompt with the failed checks' rule names appended as things to avoid. Hints are rule names, never model prose (Bible 1). */
export function promptWithHints(prompt: string, hints: readonly string[]): string {
  const safe = [...new Set(hints)].filter((hint) => HINT_PATTERN.test(hint)).sort().slice(0, 8);
  if (safe.length === 0) return prompt;
  return `${prompt} Avoid: ${safe.map((hint) => hint.replace(/_/g, " ")).join(", ")}.`;
}

/**
 * The asset spec of one generate call (Bible 10.1). It is built from the plan's shot, the attempt and the hints, so a replay
 * builds the same spec with the same cache key, and a redo (a new attempt, with hints) builds a new one.
 */
export function assetSpecFor(input: { requestId: string; shot: ShotSpec; attempt: number; hints: readonly string[] }): AssetSpec {
  const source = input.shot.source;
  if (source.kind !== "generate") {
    throw new EngineError("invalid_input", `${input.shot.shotId} is a ${source.kind} shot and has no asset spec`, { stage: "produce_shot" });
  }
  const label = `${input.requestId}|${input.shot.shotId}|${input.attempt}`;
  const spec = {
    schema: "meridian.asset_spec/v1" as const,
    specId: stableId("asp_", `asset|${label}`),
    shotId: input.shot.shotId,
    modelClass: source.modelClass,
    prompt: promptWithHints(source.prompt, input.hints),
    refs: [...source.refs],
    ...(source.firstFrame === undefined ? {} : { firstFrame: source.firstFrame }),
    ...(source.lastFrame === undefined ? {} : { lastFrame: source.lastFrame }),
    durationMs: input.shot.endMs - input.shot.startMs,
    aspect: "9:16" as const,
    width: TAKE_WIDTH,
    height: TAKE_HEIGHT,
    seed: seedFor(label),
    takes: source.takes,
  };
  return assetSpecSchema.parse(spec);
}

/** The take id of one produce job: the same job always names the same take. */
export function takeIdFor(requestId: string, shotId: string, attempt: number): string {
  return stableId("take_", `produce_shot|${requestId}|${shotId}|${attempt}`);
}

/** An mp4 has "ftyp" at byte 4 (ISO base media file format). */
export function isMp4(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

/** The shape a stored take must have, from its probe. Null when any part is unknown or differs (fail closed, Bible 12). */
export function takeShapeOf(probe: ProbeResult): { durationMs: number; width: number; height: number } | null {
  if (probe.videoCodec !== "h264") return null;
  if (probe.width !== TAKE_WIDTH || probe.height !== TAKE_HEIGHT) return null;
  if (probe.durationMs === null || probe.durationMs <= 0) return null;
  return { durationMs: probe.durationMs, width: probe.width, height: probe.height };
}

type Refused = { kind: "hold"; hold: ProduceHold };
type Stored = { kind: "take"; takeId: string; artifacts: Record<string, string> };

/** The request's brand, which the media store is keyed by. A request with no brand has no media store (fail closed). */
async function brandOf(sql: Sql, organizationId: string, requestId: string): Promise<string> {
  const rows = await sql<{ brand_id: string | null }>`
    select brand_id from engine_requests where id = ${requestId} and organization_id = ${organizationId} limit 1
  `;
  const brand = rows[0]?.brand_id ?? null;
  if (brand === null) {
    throw new EngineError("invalid_input", "the request has no brand, so its take media cannot be stored (Bible 5.2)", {
      stage: "produce_shot",
      retryable: false,
    });
  }
  return brand;
}

/** Downloads, checks, probes and stores one take, then writes its Take artifact. Refuses a file of another shape as a hold. */
async function storeTake(
  ctx: StageContext,
  ports: ProduceShotPorts,
  input: {
    shotId: string;
    planArtifactId: string;
    attempt: number;
    providerId: string;
    model: string;
    url: string;
    downloadProvider: string;
    promptHash: string;
    costUsd: number;
    latencyMs: number;
    createdAt: string;
  },
): Promise<Stored | Refused> {
  const refuse = (): Refused => ({ kind: "hold", hold: { kind: "refused", errorKind: "invalid_input", hint: "invalid_output" } });
  const bytes = await ports.downloader.download({
    providerId: input.downloadProvider,
    organizationId: ctx.organizationId,
    url: input.url,
    maxBytes: TAKE_MAX_BYTES,
    signal: ctx.signal,
  });
  if (!isMp4(bytes)) return refuse();

  let probe: ProbeResult;
  try {
    probe = await ports.media.probe({ source: { kind: "bytes", bytes } });
  } catch (error) {
    if (error instanceof EngineError && error.kind === "invalid_input") return refuse();
    throw error;
  }
  const shape = takeShapeOf(probe);
  if (shape === null) return refuse();

  const brandId = await brandOf(ctx.sql, ctx.organizationId, ctx.requestId);
  const artifactId = newId("art_");
  const takeId = takeIdFor(ctx.requestId, input.shotId, input.attempt);
  const uri = mediaKey({ workspaceId: ctx.organizationId, requestId: ctx.requestId, stage: ctx.stage, artifactId, extension: "mp4" });
  const take: Take = takeSchema.parse({
    schema: "meridian.take/v1",
    takeId,
    shotId: input.shotId,
    attempt: input.attempt,
    provider: input.providerId,
    model: input.model,
    uri,
    durationMs: shape.durationMs,
    width: shape.width,
    height: shape.height,
    promptHash: input.promptHash,
    costUsd: input.costUsd,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
  });
  await writeArtifact(ctx.sql, {
    organizationId: ctx.organizationId,
    requestId: ctx.requestId,
    stage: ctx.stage,
    type: "take",
    body: take,
    parentIds: [input.planArtifactId],
    createdAt: input.createdAt,
    artifactId,
    media: { store: ports.objects, brandId, extension: "mp4", bytes },
  });
  return { kind: "take", takeId, artifacts: { [`take:${takeId}`]: artifactId } };
}

/** The StageOutput of a produce job. Exactly one of a take and a hold is set. */
function outputFor(shotId: string, epoch: number, made: Stored | Refused, decisions: Decision[]): StageOutput {
  if (made.kind === "take") {
    return { stage: "produce_shot", subjectId: shotId, shotId, takeId: made.takeId, epoch, artifacts: made.artifacts, decisions };
  }
  return { stage: "produce_shot", subjectId: shotId, shotId, takeId: null, epoch, artifacts: {}, hold: made.hold, decisions };
}

/** Refusals the planner rewrites once (Bible 10.4). Anything else from the router is not a refusal and is thrown. */
function refusalKind(error: ProviderError): "content_policy" | "invalid_input" {
  if (error.kind === "content_policy" || error.kind === "invalid_input") return error.kind;
  throw new EngineError("provider", `a ${error.kind} failure reached produce_shot as a refusal`, { retryable: true, stage: "produce_shot" });
}

function joined(reasons: readonly string[]): string {
  return reasons.length > 0 ? reasons.join("; ") : "no reason was given";
}

/** Turns a generator's production into the take or the hold it stands for. Throws for the outcomes that are not the shot's fault. */
async function fromProduction(
  ctx: StageContext,
  ports: ProduceShotPorts,
  shot: ShotSpec,
  planArtifactId: string,
  attempt: number,
  production: ShotProduction,
  spec: AssetSpec,
  startedMs: number,
): Promise<{ made: Stored | Refused; decisions: Decision[] }> {
  const clock = ports.now ?? Date.now;
  switch (production.status) {
    case "done": {
      const { provider, model } = splitAdapterId(production.providerId);
      const made = await storeTake(ctx, ports, {
        shotId: shot.shotId,
        planArtifactId,
        attempt,
        providerId: provider,
        model,
        url: production.uri,
        downloadProvider: provider,
        promptHash: contentHash(spec.prompt),
        costUsd: production.costUsd,
        latencyMs: clock() - startedMs,
        createdAt: new Date(clock()).toISOString(),
      });
      return { made, decisions: production.decisions };
    }
    case "refused":
      return { made: { kind: "hold", hold: { kind: "budget", reason: joined(production.reasons) } }, decisions: production.decisions };
    case "failed": {
      const errorKind = refusalKind(production.error);
      return { made: { kind: "hold", hold: { kind: "refused", errorKind, hint: errorKind } }, decisions: production.decisions };
    }
    case "unavailable":
      throw new EngineError("provider", `no target produced ${shot.shotId}: ${joined(production.reasons)}`, { retryable: true, stage: "produce_shot" });
    case "queued":
      throw new EngineError("provider", `${shot.shotId} waits for a provider slot: ${joined(production.reasons)}`, { retryable: true, stage: "produce_shot" });
    case "not_connected":
      throw new EngineError("config", `${shot.shotId} has no connected provider: ${joined(production.reasons)}`, { retryable: false, stage: "produce_shot" });
    case "duplicate":
      throw new EngineError("conflict", `the call for ${shot.shotId} was already authorized and its asset is not held here`, {
        retryable: false,
        stage: "produce_shot",
      });
    case "submitted":
      throw new EngineError("internal", `a submitted call reached the completion path for ${shot.shotId}`, { stage: "produce_shot" });
  }
}

/** The adapter id is "<provider>:<model>" (assets/providers/openrouterVideo.ts). A id without a colon is refused. */
export function splitAdapterId(id: string): { provider: string; model: string } {
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) {
    throw new EngineError("invalid_input", `${id} is not a provider:model id`, { stage: "produce_shot" });
  }
  return { provider: id.slice(0, at), model: id.slice(at + 1) };
}

/** The plan shot a job is for, read from the scene plan it is allowed to read (Bible 5.1). */
async function planShotOf(ctx: StageContext): Promise<{ shot: ShotSpec; planArtifactId: string }> {
  const inputs = await readJobInputs(ctx.sql, { organizationId: ctx.organizationId, requestId: ctx.requestId, inputArtifactIds: ctx.payload.inputArtifactIds });
  const planned = inputs.find((input) => input.envelope.type === "scene_plan");
  if (!planned) throw new EngineError("invalid_input", `${ctx.stage} needs its scene_plan input artifact`, { stage: ctx.stage });
  const plan = scenePlanSchema.safeParse(planned.envelope.body);
  if (!plan.success) throw new EngineError("invalid_input", "the scene plan does not parse", { stage: ctx.stage });
  const shot = plan.data.shots.find((candidate) => candidate.shotId === ctx.subjectId);
  if (!shot) throw new EngineError("invalid_input", `the scene plan has no shot ${ctx.subjectId}`, { stage: ctx.stage });
  return { shot, planArtifactId: planned.envelope.artifactId };
}

function epochFor(ctx: StageContext): number {
  const epoch = epochOf(ctx.payload);
  if (epoch === undefined) throw new EngineError("invalid_input", "a produce job must name the plan epoch it was queued for", { stage: ctx.stage });
  return epoch;
}

function attemptFor(ctx: StageContext): number {
  const attempt = Number(ctx.payload.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new EngineError("invalid_input", "a produce job's attempt is a whole number from 1", { stage: ctx.stage });
  return attempt;
}

/**
 * The produce_shot stage. run() makes the take for a generate or stock shot. For an asynchronous generator it returns submitted, and
 * finish() settles the call when the poller sees it done or refused.
 */
export function createProduceShotHandler(ports: ProduceShotPorts): StageHandler {
  const now = ports.now ?? Date.now;
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const { shot, planArtifactId } = await planShotOf(ctx);
      const epoch = epochFor(ctx);
      const attempt = attemptFor(ctx);
      const source = shot.source;

      if (source.kind === "generate") {
        const started = now();
        const spec = assetSpecFor({ requestId: ctx.requestId, shot, attempt, hints: ctx.payload.hints });
        const reservationId = requireReservation(ctx);
        const production = await ports.generator.generate({
          sql: ctx.sql,
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          reservationId,
          spec,
          visualType: shot.visualType,
        });
        if (production.status === "submitted") {
          return { kind: "submitted", provider: production.providerId, jobRef: production.jobRef, submittedAt: production.submittedAt };
        }
        const { made, decisions } = await fromProduction(ctx, ports, shot, planArtifactId, attempt, production, spec, started);
        return { kind: "done", output: outputFor(shot.shotId, epoch, made, decisions) };
      }

      if (source.kind === "stock") {
        const started = now();
        const outcome = await ports.stock({ organizationId: ctx.organizationId, query: source.query, minDurationMs: source.minMs });
        if (outcome.status === "no_results") {
          const hold: ProduceHold = { kind: "refused", errorKind: "invalid_input", hint: "stock_no_match" };
          return { kind: "done", output: outputFor(shot.shotId, epoch, { kind: "hold", hold }, []) };
        }
        if (outcome.status === "not_connected") {
          throw new EngineError("config", `no stock source is connected: ${joined(outcome.reasons)}`, { retryable: false, stage: "produce_shot" });
        }
        if (outcome.status === "failed") {
          throw new EngineError("provider", `the stock search failed: ${joined(outcome.reasons)}`, { retryable: true, stage: "produce_shot" });
        }
        // The take gate checks the take's length against the shot (Bible 6.7), and a stock clip is not trimmed here, so the clip
        // must already fit: the first of the search's clips within the duration tolerance. None fitting is a refusal for the planner.
        const planned = shot.endMs - shot.startMs;
        const clip = outcome.clips.find((candidate) => Math.abs(candidate.durationMs - planned) / planned <= thresholds.take.durationTolerance.value);
        if (clip === undefined) {
          const hold: ProduceHold = { kind: "refused", errorKind: "invalid_input", hint: "stock_duration" };
          return { kind: "done", output: outputFor(shot.shotId, epoch, { kind: "hold", hold }, []) };
        }
        const made = await storeTake(ctx, ports, {
          shotId: shot.shotId,
          planArtifactId,
          attempt,
          providerId: outcome.providerId,
          model: STOCK_MODEL,
          url: clip.downloadUrl,
          downloadProvider: outcome.providerId,
          promptHash: contentHash(source.query),
          costUsd: STOCK_COST_USD,
          latencyMs: now() - started,
          createdAt: new Date(now()).toISOString(),
        });
        const decision: Decision = {
          at: new Date(now()).toISOString(),
          chose: `${outcome.providerId}:${clip.clipId}`,
          alternatives: [],
          reason: `the first stock clip for the query, in route order; licence ${clip.licence.status} (Bible 10.3, E2.6)`,
          by: "scorer",
        };
        return { kind: "done", output: outputFor(shot.shotId, epoch, made, [decision]) };
      }

      throw new EngineError("invalid_input", `${shot.shotId} is a ${source.kind} shot and needs no produce job`, { stage: "produce_shot" });
    },

    async finish(ctx: StageContext, polled: ProviderPoll): Promise<StageOutput> {
      const submission = ctx.poll;
      if (!submission || !ports.generator.settle) {
        throw new EngineError("internal", "produce_shot has no asynchronous generator to settle a call with", { stage: "produce_shot" });
      }
      const { shot, planArtifactId } = await planShotOf(ctx);
      const attempt = attemptFor(ctx);
      const spec = assetSpecFor({ requestId: ctx.requestId, shot, attempt, hints: ctx.payload.hints });
      const production = await ports.generator.settle(
        { sql: ctx.sql, organizationId: ctx.organizationId, requestId: ctx.requestId, reservationId: requireReservation(ctx), spec, visualType: shot.visualType },
        polled,
        { providerId: submission.provider, jobRef: submission.jobRef, submittedAt: submission.submittedAt },
      );
      const startedMs = Number.isNaN(Date.parse(submission.submittedAt)) ? (ports.now ?? Date.now)() : Date.parse(submission.submittedAt);
      const { made, decisions } = await fromProduction(ctx, ports, shot, planArtifactId, attempt, production, spec, startedMs);
      return outputFor(shot.shotId, epochFor(ctx), made, decisions);
    },
  };
}

function requireReservation(ctx: StageContext): string {
  if (ctx.payload.budgetReservationId === null) {
    throw new EngineError("invalid_input", "produce_shot is a paid stage and has no budget reservation (Bible 14)", { stage: ctx.stage });
  }
  return ctx.payload.budgetReservationId;
}
