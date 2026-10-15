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
// Asynchronous providers (Bible 15.2). A generated take is submitted through the router's submit: run() returns submitted with the
// asset job as its carry, and the poller polls the provider. When the call is finished, finish() settles it through the router's
// settle, which reconciles the bill and may move the call to the next target (submitted again). One downloader takes every take:
// this handler's (gateway/download.ts). The router's own downloader is not set, so no take is downloaded twice.

import { z } from "zod";
import {
  EngineError,
  assetSpecSchema,
  contentHash,
  chainInputsOf,
  decisionSchema,
  newId,
  scenePlanSchema,
  sumUsd,
  takeSchema,
  type AssetSpec,
  type ChainCall,
  type ChainInput,
  type Decision,
  type ProviderError,
  type ShotSpec,
  type Take,
} from "../../contracts/index.ts";
import type { ProviderPoll } from "../../contracts/assets.ts";
import { closingComponentOf, closingComponentProblem, libraryHas } from "../../plan/chains.ts";
import type { AsyncAssetRouter, ProduceInput, ProduceReport, StepReport } from "../../assets/router.ts";
import { normaliseHttpsUrl } from "../../assets/normalise.ts";
import { chainOutputSchema, readChainCall, recordChainOutput, recordChainSpec, type ChainCallKey, type ChainOutput } from "../chain-store.ts";
import { parseAssetJob, type AssetJob } from "../../assets/job.ts";
import type { StockOutcome } from "../../assets/stock.ts";
import type { MediaDownloader } from "../../gateway/download.ts";
import type { MediaFunctions, ProbeResult } from "../../media/interface.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";
import { FFMPEG_LIMITS } from "../../../../functions/ffmpeg/limits.ts";
import { thresholds } from "../../config/thresholds.ts";
import { mediaKey, readJobInputs, writeArtifact, type MediaStorePort } from "../artifact-store.ts";
import { stableId, seedFor } from "../stable-id.ts";
import { epochOf, type ProduceHold, type StageContext, type StageHandler, type StageOutput, type StageRunResult } from "../types.ts";

export { chainOutputSchema };
export type { ChainOutput };

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
  /** The router submitted the call. job is the router's asset job: the poller carries it, and settle receives it back. */
  | { status: "submitted"; providerId: string; jobRef: string; submittedAt: string; job: AssetJob; runAfterMs: number; decisions: Decision[] }
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

/** Makes the generated take. generate submits; settle finishes a submit once the poller has its answer (Bible 15.2). */
export interface ShotGenerator {
  generate(input: GenerateInput): Promise<ShotProduction>;
  settle(input: GenerateInput, job: AssetJob, polled: ProviderPoll): Promise<ShotProduction>;
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
  /**
   * Whether the component library draws a closing component (a chain's player). Absent, the library itself answers. A chain whose
   * closing component is not drawn is refused before its first call, so no frame is paid for a shot that cannot be drawn.
   */
  componentHas?: (component: string) => boolean;
  /**
   * Makes a chain's input (a reference or a frame the provider reads) into a link the provider can fetch: an https URL (Bible 10.1).
   * The stored uri of a call's output or of a kit image is not one. Absent, the stored uri is sent as it is, and an adapter that needs
   * https refuses it before any call. A link that cannot be made for an input stops the chain as a hold (the call is not made). A link
   * service that is not connected is thrown, as a config error, so nothing is sent.
   */
  providerUrl?: (input: { organizationId: string; uri: string }) => Promise<string>;
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

/** The router's input for one generated take (the stage is the budget stage name). */
function routerInputOf(input: GenerateInput): ProduceInput {
  return {
    spec: input.spec,
    workspaceId: input.organizationId,
    requestId: input.requestId,
    reservationId: input.reservationId,
    stage: "produce_shot",
    visualType: input.visualType,
    continuityProvider: null,
    voiceId: null,
  };
}

/** A router step as the generator reports it: a submitted call carries its job, anything else is terminal. */
function productionFromStep(report: StepReport): ShotProduction {
  const step = report.step;
  if (step.status === "submitted") {
    return {
      status: "submitted",
      providerId: step.job.providerId,
      jobRef: step.job.jobRef,
      submittedAt: step.job.submittedAt,
      job: step.job,
      runAfterMs: step.runAfterMs,
      decisions: report.decisions,
    };
  }
  return productionFromReport({ outcome: step, decisions: report.decisions, alerts: report.alerts, attempts: report.attempts });
}

/**
 * The generator that runs the asset router (E3): generate submits, and settle finishes a submit the poller has answered. Both use the
 * router of the request's reservation, so the ledger steps are the same as the synchronous path's.
 */
export function routerGenerator(routerFor: (input: { sql: Sql; organizationId: string; requestId: string; reservationId: string }) => AsyncAssetRouter): ShotGenerator {
  const scopeOf = (input: GenerateInput) => ({ sql: input.sql, organizationId: input.organizationId, requestId: input.requestId, reservationId: input.reservationId });
  return {
    async generate(input) {
      const router = routerFor(scopeOf(input));
      return productionFromStep(await router.submit(routerInputOf(input)));
    },
    async settle(input, job, polled) {
      const router = routerFor(scopeOf(input));
      return productionFromStep(await router.settle(job, polled, routerInputOf(input)));
    },
  };
}

/** The asset job a poll carries (carry = { job, decisions }). It is parsed again here: the poll payload is stored JSON (Bible 1). */
function carriedJob(carry: unknown): AssetJob {
  const value = typeof carry === "object" && carry !== null ? (carry as { job?: unknown }).job : undefined;
  return parseAssetJob(value);
}

/** The router's decisions from the submits so far, carried with the job, so the settled take keeps every decision (Bible L7). */
function carriedDecisionsOf(carry: unknown): Decision[] {
  const value = typeof carry === "object" && carry !== null ? (carry as { decisions?: unknown }).decisions : undefined;
  if (value === undefined) return [];
  const parsed = z.array(decisionSchema).safeParse(value);
  if (!parsed.success) {
    throw new EngineError("internal", "the decisions carried by a poll do not parse", { stage: "produce_shot" });
  }
  return parsed.data;
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
export function assetSpecFor(input: { requestId: string; shot: ShotSpec; attempt: number; hints: readonly string[]; subject?: string }): AssetSpec {
  const source = input.shot.source;
  if (source.kind !== "generate") {
    throw new EngineError("invalid_input", `${input.shot.shotId} is a ${source.kind} shot and has no asset spec`, { stage: "produce_shot" });
  }
  // The label names the job's subject: a master shot's subject is its id, and a variant's shot has its own (variants/work.ts), so the
  // variant's take is never the master's take, nor the cached answer of the master's call.
  const label = `${input.requestId}|${input.subject ?? input.shot.shotId}|${input.attempt}`;
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
  // The take is named by the job's subject (a master shot's subject is its id), so a variant's take has its own id.
  const takeId = takeIdFor(ctx.requestId, ctx.subjectId, input.attempt);
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
function outputFor(subjectId: string, shotId: string, epoch: number, made: Stored | Refused, decisions: Decision[]): StageOutput {
  if (made.kind === "take") {
    return { stage: "produce_shot", subjectId, shotId, takeId: made.takeId, epoch, artifacts: made.artifacts, decisions };
  }
  return { stage: "produce_shot", subjectId, shotId, takeId: null, epoch, artifacts: {}, hold: made.hold, decisions };
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
  const shotId = shotIdOf(ctx);
  const shot = plan.data.shots.find((candidate) => candidate.shotId === shotId);
  if (!shot) throw new EngineError("invalid_input", `the scene plan has no shot ${shotId}`, { stage: ctx.stage });
  return { shot, planArtifactId: planned.envelope.artifactId };
}

/**
 * The plan shot a produce job makes. A master job's subject is its shot id. A variant's job has its own subject, and names its shot in its
 * details (variants/work.ts), so the shot is found in the variant's plan under its plan id.
 */
function shotIdOf(ctx: StageContext): string {
  const named = ctx.payload.details.shotId;
  return typeof named === "string" && named.length > 0 ? named : ctx.subjectId;
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

// --- Chains (contract v5, Bible 7.1). A shot whose source is a chain makes its calls in order. Each call is one generation on the
// request's reservation: its own spec (so its own cache key, the input hash), its own ledger entry (the router writes it on the submit),
// and its own output, which a later call of the same chain reads by name. The last call's video is the shot's take. A chain that ends
// in an image (stop-motion frames) has no take: its closing component draws the frames (Bible 6.6), so the output names the component
// and holds no take. A refused or failed call stops the chain: no later call is made, and the hold names the call.
//
// Records (chain-store.ts, Bible 5.1). Each call is recorded before it is made, with its spec, and its output is recorded when it is
// made. A retry of the produce job reads those records: a made call is read back, and the call that follows is made with the spec it
// was recorded with. So a retry never makes a call twice for one key and never builds a second link for one input.

/** How far a chain has got: the index of its next call, when it started, and the outputs of the calls made. Carried on the poll. */
export const chainProgressSchema = z.object({
  index: z.number().int().nonnegative(),
  startedAt: z.string().min(1),
  outputs: z.array(chainOutputSchema),
});
export type ChainProgress = z.infer<typeof chainProgressSchema>;

/**
 * The asset spec of one call of a chain. Its inputs are the assets it names and the outputs of the earlier calls, as their uris. `linkOf`
 * maps each such uri to the link the spec carries (the provider's fetchable URL); absent, the uri is the link.
 */
export function chainCallSpecFor(input: {
  requestId: string;
  shot: ShotSpec;
  calls: readonly ChainCall[];
  index: number;
  attempt: number;
  hints: readonly string[];
  outputs: readonly ChainOutput[];
  linkOf?: (uri: string) => string;
}): AssetSpec {
  const call = input.calls[input.index];
  if (call === undefined) {
    throw new EngineError("internal", `${input.shot.shotId} has no call ${input.index} in its chain`, { stage: "produce_shot" });
  }
  const linkOf = input.linkOf ?? ((uri: string) => uri);
  const resolve = (ref: ChainInput): string => linkOf(uriOfInput(ref, input.outputs, input.shot.shotId, call.output));
  // The label names the call, so each call of a chain has its own seed, spec id and cache key (the input hash, Bible 10.4).
  const label = `${input.requestId}|${input.shot.shotId}|${input.attempt}|${call.output}`;
  const firstFrame = call.firstFrame === undefined ? undefined : resolve(call.firstFrame);
  const lastFrame = call.lastFrame === undefined ? undefined : resolve(call.lastFrame);
  return assetSpecSchema.parse({
    schema: "meridian.asset_spec/v1",
    specId: stableId("asp_", `asset|${label}`),
    shotId: input.shot.shotId,
    modelClass: call.modelClass,
    prompt: promptWithHints(call.prompt, input.hints),
    refs: call.refs.map(resolve),
    ...(firstFrame === undefined ? {} : { firstFrame }),
    ...(lastFrame === undefined ? {} : { lastFrame }),
    durationMs: input.shot.endMs - input.shot.startMs,
    aspect: "9:16",
    width: TAKE_WIDTH,
    height: TAKE_HEIGHT,
    seed: seedFor(label),
    takes: call.takes,
  });
}

/** The uri a chain input stands for: an asset's own uri, or the uri of the earlier call of that name. An unknown name is an internal error. */
function uriOfInput(ref: ChainInput, outputs: readonly ChainOutput[], shotId: string, callName: string): string {
  if (ref.kind === "asset") return ref.uri;
  const made = outputs.find((output) => output.output === ref.output);
  if (made === undefined) {
    throw new EngineError("internal", `call ${callName} of ${shotId} reads ${ref.output}, which no earlier call made`, { stage: "produce_shot" });
  }
  return made.uri;
}

/** The record key of one call of a chain run (the request, the shot, the job's attempt and the call's output name). */
function keyOf(run: ChainRun, output: string): ChainCallKey {
  return { organizationId: run.ctx.organizationId, requestId: run.ctx.requestId, shotId: run.shot.shotId, attempt: run.attempt, output };
}

/**
 * The links for the inputs of a call that the provider reads and that are not https yet: each uri is linked once, through the ports.
 * Absent the port, there are no links and the stored uris are sent as they are (the adapter refuses what it cannot read).
 */
async function linksFor(run: ChainRun, call: ChainCall, outputs: readonly ChainOutput[]): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  const providerUrl = run.ports.providerUrl;
  if (providerUrl === undefined) return links;
  for (const input of chainInputsOf(call)) {
    const uri = uriOfInput(input, outputs, run.shot.shotId, call.output);
    if (links.has(uri) || normaliseHttpsUrl(uri).ok) continue;
    const link = await providerUrl({ organizationId: run.ctx.organizationId, uri });
    if (!normaliseHttpsUrl(link).ok) {
      throw new EngineError("invalid_input", `the link made for an input of ${call.output} is not an https URL the provider can fetch`, {
        stage: "produce_shot",
      });
    }
    links.set(uri, link);
  }
  return links;
}

/** The spec of one call, pinned by its record (Bible 5.1). See specOfCall. */
type CallSpec = { kind: "spec"; spec: AssetSpec } | { kind: "unlinked"; reason: string };

/**
 * The spec of the call at `index`. A recorded call returns the spec it was recorded with, so a retry makes the same call. A call with no
 * record is built from the outputs before it, its inputs as links, and recorded before it is made. An input that cannot be linked is
 * returned as unlinked, so the chain stops before the call with a hold; a link service that is not connected is thrown.
 */
async function specOfCall(run: ChainRun, index: number, outputs: readonly ChainOutput[]): Promise<CallSpec> {
  const call = run.calls[index];
  if (call === undefined) throw new EngineError("internal", `${run.shot.shotId} has no call ${index} in its chain`, { stage: "produce_shot" });
  const key = keyOf(run, call.output);
  const recorded = await readChainCall(run.ctx.sql, key);
  if (recorded !== null) return { kind: "spec", spec: recorded.spec };
  let links: Map<string, string>;
  try {
    links = await linksFor(run, call, outputs);
  } catch (error) {
    if (error instanceof EngineError && error.kind === "invalid_input") return { kind: "unlinked", reason: error.message };
    throw error;
  }
  const spec = chainCallSpecFor({
    requestId: run.ctx.requestId,
    shot: run.shot,
    calls: run.calls,
    index,
    attempt: run.attempt,
    hints: run.ctx.payload.hints,
    outputs,
    linkOf: (uri) => links.get(uri) ?? uri,
  });
  const stored = await recordChainSpec(run.ctx.sql, { ...key, callIndex: index, spec, at: new Date((run.ports.now ?? Date.now)()).toISOString() });
  return { kind: "spec", spec: stored };
}

/** The decision that records a chain's stop at one call (Bible L7): the call, and why no later call is made. */
function stopDecisionOf(run: ChainRun, index: number, reason: string, clock: () => number): Decision {
  const call = run.calls[index];
  return {
    at: new Date(clock()).toISOString(),
    chose: `stopped at ${call?.output ?? "chain"}`,
    alternatives: [],
    reason,
    by: "scorer",
  };
}

/** What a chain run carries from one call to the next. */
type ChainRun = {
  ctx: StageContext;
  ports: ProduceShotPorts;
  shot: ShotSpec;
  calls: readonly ChainCall[];
  planArtifactId: string;
  epoch: number;
  attempt: number;
  progress: ChainProgress;
  decisions: Decision[];
};

/** The chain's progress carried on a poll, parsed again (the poll payload is stored JSON, Bible 1). Absent for a generate shot. */
function chainCarryOf(carry: unknown): ChainProgress | null {
  const value = typeof carry === "object" && carry !== null ? (carry as { chain?: unknown }).chain : undefined;
  if (value === undefined) return null;
  const parsed = chainProgressSchema.safeParse(value);
  if (!parsed.success) throw new EngineError("internal", "the chain progress carried by a poll does not parse", { stage: "produce_shot" });
  return parsed.data;
}

/**
 * Makes the calls of a chain in order (Bible 7.1). `settled` is the answer already in hand for the call at the progress index (a settled
 * poll), or null to make that call now. Returns submitted while a call is with the provider, the take when the last call is a video, or
 * the hold of the call that stopped the chain. Each call's ledger entry is written by the router, so every call has one (checked here).
 */
async function driveChain(run: ChainRun, settled: ShotProduction | null): Promise<StageRunResult> {
  const { ctx, ports, shot } = run;
  let progress = run.progress;
  let decisions = run.decisions;
  let answer = settled;
  for (;;) {
    const call = run.calls[progress.index];
    if (call === undefined) return finishChain({ ...run, progress, decisions });
    const recorded = await readChainCall(ctx.sql, keyOf(run, call.output));
    if (recorded?.output) {
      // Made by an earlier run of this job: its output is read back, and no call is made for it (Bible 5.1).
      if (answer !== null) {
        throw new EngineError("conflict", `call ${call.output} of ${shot.shotId} was made by an earlier run; its settled answer is not used`, {
          stage: "produce_shot",
          retryable: false,
        });
      }
      progress = { index: progress.index + 1, startedAt: progress.startedAt, outputs: [...progress.outputs, recorded.output] };
      continue;
    }
    const built = await specOfCall(run, progress.index, progress.outputs);
    if (built.kind === "unlinked") {
      // An input the provider cannot read is a refusal before the call: nothing is spent, and the planner may rewrite the call once.
      const stop = stopDecisionOf(run, progress.index, `call ${progress.index + 1} of ${run.calls.length} (${call.modelClass}) has an input the provider cannot read: ${built.reason}; no call is made`, ports.now ?? Date.now);
      const hold: ProduceHold = { kind: "refused", errorKind: "invalid_input", hint: "unlinked_input" };
      return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId, run.epoch, { kind: "hold", hold }, [...decisions, stop]) };
    }
    const spec = built.spec;
    const production =
      answer ??
      (await ports.generator.generate({
        sql: ctx.sql,
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        reservationId: requireReservation(ctx),
        spec,
        visualType: shot.visualType,
      }));
    answer = null;

    if (production.status === "submitted") {
      return {
        kind: "submitted",
        provider: production.providerId,
        jobRef: production.jobRef,
        submittedAt: production.submittedAt,
        carry: { job: production.job, decisions: [...decisions, ...production.decisions], chain: progress },
      };
    }

    if (production.status !== "done") {
      // A refusal or a failure stops the chain here. No later call is made, and the hold names the call that stopped it.
      const { made, decisions: callDecisions } = await fromProduction(ctx, ports, shot, run.planArtifactId, run.attempt, production, spec, Date.parse(progress.startedAt));
      const named: Stored | Refused =
        made.kind === "hold" && made.hold.kind === "budget" ? { kind: "hold", hold: { kind: "budget", reason: `${call.output}: ${made.hold.reason}` } } : made;
      const stop = stopDecisionOf(
        run,
        progress.index,
        `call ${progress.index + 1} of ${run.calls.length} (${call.modelClass}) did not make an output, so no later call is made`,
        ports.now ?? Date.now,
      );
      return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId, run.epoch, named, [...decisions, ...callDecisions, stop]) };
    }

    if (!production.cacheHit && production.ledgerEntryId === null) {
      throw new EngineError("internal", `call ${call.output} of ${shot.shotId} was made with no ledger entry`, { stage: "produce_shot" });
    }
    const made: ChainOutput = {
      output: call.output,
      modelClass: call.modelClass,
      uri: production.uri,
      mediaType: production.mediaType,
      providerId: production.providerId,
      promptHash: contentHash(spec.prompt),
      costUsd: production.costUsd,
      costIsEstimate: production.costIsEstimate,
      cacheHit: production.cacheHit,
      ledgerEntryId: production.ledgerEntryId,
    };
    // The output is recorded before the next call reads it, so a retry reads it back and makes no second call (Bible 5.1).
    await recordChainOutput(ctx.sql, { ...keyOf(run, call.output), made, at: new Date((ports.now ?? Date.now)()).toISOString() });
    progress = { index: progress.index + 1, startedAt: progress.startedAt, outputs: [...progress.outputs, made] };
    decisions = [...decisions, ...production.decisions];
    if (progress.index >= run.calls.length) return finishChain({ ...run, progress, decisions });
  }
}

/**
 * The end of a chain whose calls were all made. A video last call is the shot's take: it is downloaded and checked like any take, and
 * its cost is the sum of every call. A chain that ends in an image has no take: the closing component draws the frames, and the output
 * names it (decision), with no take and no hold.
 */
async function finishChain(run: ChainRun): Promise<StageRunResult> {
  const { ctx, ports, shot } = run;
  const clock = ports.now ?? Date.now;
  const last = run.progress.outputs[run.progress.outputs.length - 1];
  const finalCall = run.calls[run.calls.length - 1];
  if (last === undefined || finalCall === undefined) {
    throw new EngineError("internal", `the chain of ${shot.shotId} ended with no output`, { stage: "produce_shot" });
  }
  if (!finalCall.modelClass.startsWith("video.")) {
    const component = closingComponentOf(shot.visualType);
    if (component === undefined) {
      throw new EngineError("invalid_input", `${shot.shotId} ends in an image and has no closing component`, { stage: "produce_shot" });
    }
    const closing: Decision = {
      at: new Date(clock()).toISOString(),
      chose: component,
      alternatives: [],
      reason: `the ${run.calls.length} frames are made; ${component} draws them after the last call, so the shot has no take (Bible 6.6)`,
      by: "scorer",
    };
    return {
      kind: "done",
      output: { stage: "produce_shot", subjectId: ctx.subjectId, shotId: shot.shotId, takeId: null, epoch: run.epoch, artifacts: {}, decisions: [...run.decisions, closing] },
    };
  }
  const { provider, model } = splitAdapterId(last.providerId);
  const made = await storeTake(ctx, ports, {
    shotId: shot.shotId,
    planArtifactId: run.planArtifactId,
    attempt: run.attempt,
    providerId: provider,
    model,
    url: last.uri,
    downloadProvider: provider,
    promptHash: last.promptHash,
    costUsd: sumUsd(run.progress.outputs.map((output) => output.costUsd)),
    latencyMs: clock() - Date.parse(run.progress.startedAt),
    createdAt: new Date(clock()).toISOString(),
  });
  return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId, run.epoch, made, run.decisions) };
}

/**
 * The produce_shot stage. run() makes the take for a generate or stock shot, or drives a chain's calls. For an asynchronous generator it
 * returns submitted, and finish() settles the call when the poller sees it done or refused.
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
        const spec = assetSpecFor({ requestId: ctx.requestId, shot, attempt, hints: ctx.payload.hints, subject: ctx.subjectId });
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
          // The router's job is the poll's carry. The poller settles the call through finish, with this job.
          return {
            kind: "submitted",
            provider: production.providerId,
            jobRef: production.jobRef,
            submittedAt: production.submittedAt,
            carry: { job: production.job, decisions: production.decisions },
          };
        }
        const { made, decisions } = await fromProduction(ctx, ports, shot, planArtifactId, attempt, production, spec, started);
        return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId,epoch, made, decisions) };
      }

      if (source.kind === "stock") {
        const started = now();
        const outcome = await ports.stock({ organizationId: ctx.organizationId, query: source.query, minDurationMs: source.minMs });
        if (outcome.status === "no_results") {
          const hold: ProduceHold = { kind: "refused", errorKind: "invalid_input", hint: "stock_no_match" };
          return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId,epoch, { kind: "hold", hold }, []) };
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
          return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId,epoch, { kind: "hold", hold }, []) };
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
        return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId,epoch, made, [decision]) };
      }

      if (source.kind === "chain") {
        // Before the first call: a chain whose closing component is not drawn would pay for frames it cannot show, so it is refused here.
        const gap = closingComponentProblem(shot.visualType, ports.componentHas ?? libraryHas);
        if (gap !== null) throw new EngineError("config", `${shot.shotId}: ${gap}; no call is made`, { stage: "produce_shot", retryable: false });
        return driveChain(
          {
            ctx,
            ports,
            shot,
            calls: source.calls,
            planArtifactId,
            epoch,
            attempt,
            progress: { index: 0, startedAt: new Date((ports.now ?? Date.now)()).toISOString(), outputs: [] },
            decisions: [],
          },
          null,
        );
      }

      throw new EngineError("invalid_input", `${shot.shotId} is a ${source.kind} shot and needs no produce job`, { stage: "produce_shot" });
    },

    async finish(ctx: StageContext, polled: ProviderPoll): Promise<StageRunResult> {
      const submission = ctx.poll;
      if (!submission) {
        throw new EngineError("internal", "produce_shot was asked to finish a call it did not submit", { stage: "produce_shot" });
      }
      const job = carriedJob(submission.carry);
      const carried = carriedDecisionsOf(submission.carry);
      const { shot, planArtifactId } = await planShotOf(ctx);
      const attempt = attemptFor(ctx);
      const chain = chainCarryOf(submission.carry);
      if (chain !== null) {
        // A call of a chain: settle it, then carry on with the calls that follow (Bible 7.1). The spec is the one the call was recorded
        // with before it was submitted, so the settle checks the same spec (Bible 5.1).
        if (shot.source.kind !== "chain") throw new EngineError("internal", `${shot.shotId} carries chain progress but its source is ${shot.source.kind}`, { stage: "produce_shot" });
        const calls = shot.source.calls;
        const run: ChainRun = { ctx, ports, shot, calls, planArtifactId, epoch: epochFor(ctx), attempt, progress: chain, decisions: carried };
        const built = await specOfCall(run, chain.index, chain.outputs);
        if (built.kind !== "spec") throw new EngineError("internal", `${shot.shotId} has a settled call with no recorded spec`, { stage: "produce_shot" });
        const spec = built.spec;
        const settled = await ports.generator.settle(
          { sql: ctx.sql, organizationId: ctx.organizationId, requestId: ctx.requestId, reservationId: requireReservation(ctx), spec, visualType: shot.visualType },
          job,
          polled,
        );
        if (settled.status === "submitted") {
          return {
            kind: "submitted",
            provider: settled.providerId,
            jobRef: settled.jobRef,
            submittedAt: settled.submittedAt,
            carry: { job: settled.job, decisions: [...carried, ...settled.decisions], chain },
          };
        }
        return driveChain(run, settled);
      }
      const spec = assetSpecFor({ requestId: ctx.requestId, shot, attempt, hints: ctx.payload.hints, subject: ctx.subjectId });
      const production = await ports.generator.settle(
        { sql: ctx.sql, organizationId: ctx.organizationId, requestId: ctx.requestId, reservationId: requireReservation(ctx), spec, visualType: shot.visualType },
        job,
        polled,
      );
      if (production.status === "submitted") {
        // Settling moved the call to its next target: the poller schedules that poll, and nothing is written yet.
        return {
          kind: "submitted",
          provider: production.providerId,
          jobRef: production.jobRef,
          submittedAt: production.submittedAt,
          carry: { job: production.job, decisions: [...carried, ...production.decisions] },
        };
      }
      const { made, decisions } = await fromProduction(ctx, ports, shot, planArtifactId, attempt, production, spec, Date.parse(job.submittedAt));
      return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId,epochFor(ctx), made, [...carried, ...decisions]) };
    },
  };
}

function requireReservation(ctx: StageContext): string {
  if (ctx.payload.budgetReservationId === null) {
    throw new EngineError("invalid_input", "produce_shot is a paid stage and has no budget reservation (Bible 14)", { stage: ctx.stage });
  }
  return ctx.payload.budgetReservationId;
}
