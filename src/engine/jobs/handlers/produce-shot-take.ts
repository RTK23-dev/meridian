// Making a take from a production: the router's input and generator, the stored take and its outcome, and the take's id and
// shape. Moved out of engine/jobs/handlers/produce-shot.ts unchanged (coding loop, T9b). produce-shot.ts re-exports the public names.

import { z } from "zod";
import { EngineError, contentHash, decisionSchema, newId, takeSchema, type AssetSpec, type Decision, type ProviderError, type ShotSpec, type Take } from "../../contracts/index.ts";
import type { AsyncAssetRouter, ProduceInput, ProduceReport, StepReport } from "../../assets/router.ts";
import { parseAssetJob, type AssetJob } from "../../assets/job.ts";
import type { ProbeResult } from "../../media/interface.ts";
import type { Sql } from "../../../lib/meridian/learning/store.ts";
import { mediaKey, writeArtifact } from "../artifact-store.ts";
import { stableId } from "../stable-id.ts";
import type { StageContext, StageOutput } from "../types.ts";
import { TAKE_MAX_BYTES, TAKE_WIDTH, TAKE_HEIGHT } from "./produce-shot-types.ts";
import type { ShotProduction, GenerateInput, ShotGenerator, ProduceShotPorts, Refused, Stored } from "./produce-shot-types.ts";

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
    case "unsettled":
      return { status: "unsettled", providerId: outcome.providerId, idempotencyKey: outcome.idempotencyKey, ledgerEntryId: outcome.ledgerEntryId, reason: outcome.reason, decisions };
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

export function carriedJob(carry: unknown): AssetJob {
  const value = typeof carry === "object" && carry !== null ? (carry as { job?: unknown }).job : undefined;
  return parseAssetJob(value);
}

/** The router's decisions from the submits so far, carried with the job, so the settled take keeps every decision (Bible L7). */

export function carriedDecisionsOf(carry: unknown): Decision[] {
  const value = typeof carry === "object" && carry !== null ? (carry as { decisions?: unknown }).decisions : undefined;
  if (value === undefined) return [];
  const parsed = z.array(decisionSchema).safeParse(value);
  if (!parsed.success) {
    throw new EngineError("internal", "the decisions carried by a poll do not parse", { stage: "produce_shot" });
  }
  return parsed.data;
}

/** The prompt with the failed checks' rule names appended as things to avoid. Hints are rule names, never model prose (Bible 1). */

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

export async function storeTake(
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

export function outputFor(subjectId: string, shotId: string, epoch: number, made: Stored | Refused, decisions: Decision[]): StageOutput {
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

export function joined(reasons: readonly string[]): string {
  return reasons.length > 0 ? reasons.join("; ") : "no reason was given";
}

/** Turns a generator's production into the take or the hold it stands for. Throws for the outcomes that are not the shot's fault. */

export async function fromProduction(
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
    case "unsettled":
      throw new EngineError("conflict", `${shot.shotId} waits for a submit to be settled, so no further paid call is made: ${production.reason}`, {
        retryable: false,
        stage: "produce_shot",
      });
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
