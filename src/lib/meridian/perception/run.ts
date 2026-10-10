/**
 * Runs perception on images or sampled video frames, and records what was analysed.
 *
 * The runner is the only place a perception provider is called from production. It validates every item before anything is
 * sent, caps the number of items per call, reuses an identical earlier observed run instead of calling the provider again,
 * and writes one record per run: the media with its hashes and real timestamps, the provider and model and prompt version,
 * the observations, and the coverage. A video is never described as inspected in full: the coverage says how many of its
 * frames were analysed.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { checkImageBytes } from "../media/image-input.ts";
import { GeminiPerceptionProvider } from "./multimodal.ts";
import type { MediaObservation, MultimodalPerceptionProvider, PerceptionFailureKind, PerceptionMedia, PerceptionMediaKind } from "./types.ts";

export const PERCEPTION_PROVIDER_ENV = "PERCEPTION_PROVIDER";
/** Items per run. Kept at the decision limit, so a video is judged on at most four frames, whatever provider is used. */
export const PERCEPTION_MAX_MEDIA = 4;

/**
 * The perception provider, chosen by its own setting. It is independent of the decision engine. Unset selects Gemini, which
 * is only usable when its key is configured. `none` turns perception off. An unknown value turns it off too, and says why.
 */
export function selectPerceptionProvider(env: Record<string, string | undefined> = process.env): {
  provider: MultimodalPerceptionProvider | null;
  reason: string;
} {
  const raw = (env[PERCEPTION_PROVIDER_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "gemini") return { provider: new GeminiPerceptionProvider(), reason: "gemini" };
  if (raw === "none") return { provider: null, reason: "Perception is turned off by PERCEPTION_PROVIDER=none." };
  return { provider: null, reason: `PERCEPTION_PROVIDER=${raw} is not a known perception provider.` };
}

export type PerceptionInputMedia = {
  id: string;
  bytes: Uint8Array;
  /** The real timestamp of a video frame. Null for a still image. Never estimated. */
  timestampMs: number | null;
  label: string;
};

export type PerceptionMediaSummary = {
  id: string;
  label: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
  timestampMs: number | null;
};

export type PerceptionCoverage = {
  scope: "still_image" | "sampled_frames";
  offered: number;
  analysed: number;
  durationMs: number | null;
  note: string;
};

export type PerceptionRunOutcome = {
  status: "observed" | "failed";
  runId: string;
  reused: boolean;
  providerId: string | null;
  model: string | null;
  promptVersion: string | null;
  observations: MediaObservation[];
  media: PerceptionMediaSummary[];
  coverage: PerceptionCoverage;
  failureKind?: PerceptionFailureKind;
  message?: string;
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonOf<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function coverageFor(kind: PerceptionMediaKind, offered: number, analysed: number, durationMs: number | null): PerceptionCoverage {
  if (kind === "image") {
    return { scope: "still_image", offered, analysed, durationMs: null, note: "A single still image was analysed." };
  }
  const note = analysed < offered
    ? `Analysed ${analysed} of ${offered} sampled frames of a ${durationMs ?? "unknown"} ms video. The video was not inspected in full.`
    : `Analysed ${analysed} sampled frames of a ${durationMs ?? "unknown"} ms video. The video was not inspected in full.`;
  return { scope: "sampled_frames", offered, analysed, durationMs, note };
}

async function record(
  sql: Sql,
  input: { organizationId: string; brandId: string; subjectType: string; subjectId: string },
  row: {
    id: string;
    providerId: string;
    model: string;
    promptVersion: string;
    requestKey: string;
    status: "observed" | "failed";
    failureKind?: PerceptionFailureKind;
    message?: string;
    media: PerceptionMediaSummary[];
    observations: MediaObservation[];
    coverage: PerceptionCoverage;
    latencyMs?: number;
    usage?: unknown;
  },
): Promise<void> {
  await sql`
    insert into perception_runs (
      id, organization_id, brand_id, subject_type, subject_id, provider, model, prompt_version, request_key, status,
      failure_kind, failure_message, media, observations, coverage, latency_ms, usage
    ) values (
      ${row.id}, ${input.organizationId}, ${input.brandId}, ${input.subjectType}, ${input.subjectId}, ${row.providerId},
      ${row.model}, ${row.promptVersion}, ${row.requestKey}, ${row.status}, ${row.failureKind ?? null}, ${row.message ?? null},
      ${JSON.stringify(row.media)}, ${JSON.stringify(row.observations)}, ${JSON.stringify(row.coverage)},
      ${row.latencyMs ?? null}, ${row.usage === undefined ? null : JSON.stringify(row.usage)}
    )
  `;
}

export async function runPerception(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    subjectType: string;
    subjectId: string;
    kind: PerceptionMediaKind;
    media: PerceptionInputMedia[];
    durationMs?: number | null;
    provider: MultimodalPerceptionProvider | null;
    /** Why there is no provider, when there is none. Recorded, so the disclosure can say it. */
    providerReason?: string;
  },
): Promise<PerceptionRunOutcome> {
  const durationMs = input.durationMs ?? null;
  const offered = input.media.length;
  const selected = input.media.slice(0, PERCEPTION_MAX_MEDIA);
  const coverage = coverageFor(input.kind, offered, selected.length, durationMs);
  // A run that analyses nothing says so in its note too, not only in its count.
  const noneCoverage = coverageFor(input.kind, offered, 0, durationMs);
  const runId = randomUUID();
  const scope = { organizationId: input.organizationId, brandId: input.brandId, subjectType: input.subjectType, subjectId: input.subjectId };

  const providerId = input.provider?.id ?? "none";
  const model = input.provider?.model ?? "none";
  const promptVersion = input.provider?.promptVersion ?? "none";
  const failedOutcome = async (failureKind: PerceptionFailureKind, message: string, media: PerceptionMediaSummary[] = []): Promise<PerceptionRunOutcome> => {
    const requestKey = sha256Hex(Buffer.from(JSON.stringify({ providerId, model, promptVersion, kind: input.kind, failureKind, subject: input.subjectId, runId })));
    await record(sql, scope, { id: runId, providerId, model, promptVersion, requestKey, status: "failed", failureKind, message, media, observations: [], coverage: noneCoverage });
    return {
      status: "failed", runId, reused: false, providerId: input.provider?.id ?? null, model: input.provider?.model ?? null,
      promptVersion: input.provider?.promptVersion ?? null, observations: [], media, coverage: noneCoverage, failureKind, message,
    };
  };

  if (!input.provider) return failedOutcome("not_configured", input.providerReason ?? "No perception provider is configured.");
  if (selected.length === 0) return failedOutcome("no_media", "No media was supplied for perception.");

  // Every item is checked by its own bytes before anything is sent. One invalid item fails the run.
  const prepared: Array<PerceptionMedia & { label: string }> = [];
  for (const [index, item] of selected.entries()) {
    const checked = checkImageBytes(item.bytes, `Media ${index + 1} (${item.label})`);
    if (!checked.ok) return failedOutcome("unsupported_media", checked.reason);
    prepared.push({ id: item.id, bytes: item.bytes, mimeType: checked.mimeType, sha256: sha256Hex(item.bytes), timestampMs: item.timestampMs, label: item.label });
  }
  const summaries: PerceptionMediaSummary[] = prepared.map((item) => ({
    id: item.id, label: item.label, sha256: item.sha256, byteLength: item.bytes.byteLength, mimeType: item.mimeType, timestampMs: item.timestampMs,
  }));

  // The same media, the same provider, model and prompt version, and the same kind have the same answer. Reuse it.
  const requestKey = sha256Hex(Buffer.from(JSON.stringify({ providerId, model, promptVersion, kind: input.kind, media: summaries.map((item) => [item.sha256, item.timestampMs]) })));
  const earlier = await sql<{ id: string; observations: unknown; media: unknown; coverage: unknown }>`
    select id, observations, media, coverage from perception_runs
    where organization_id = ${input.organizationId} and request_key = ${requestKey} and status = 'observed'
    order by created_at desc limit 1
  `;
  if (earlier[0]) {
    return {
      status: "observed", runId: earlier[0].id, reused: true, providerId, model, promptVersion,
      observations: jsonOf<MediaObservation[]>(earlier[0].observations, []),
      media: jsonOf<PerceptionMediaSummary[]>(earlier[0].media, summaries),
      coverage: jsonOf<PerceptionCoverage>(earlier[0].coverage, coverage),
    };
  }

  const health = await input.provider.health();
  if (health.state !== "HEALTHY") {
    return failedOutcome(health.state === "NOT_CONFIGURED" ? "not_configured" : "provider_unavailable", health.detail, summaries);
  }

  let result;
  try {
    result = await input.provider.perceive({ kind: input.kind, media: prepared.map(({ label: _label, ...item }) => item) });
  } catch (error) {
    result = {
      status: "failed" as const, providerId, model, promptVersion, failureKind: "provider_unavailable" as const,
      message: `The perception provider threw: ${error instanceof Error ? error.message : String(error)}`, latencyMs: 0,
    };
  }
  if (result.status === "failed") {
    await record(sql, scope, { id: runId, providerId: result.providerId, model: result.model, promptVersion: result.promptVersion, requestKey, status: "failed", failureKind: result.failureKind, message: result.message, media: summaries, observations: [], coverage: noneCoverage, latencyMs: result.latencyMs });
    return {
      status: "failed", runId, reused: false, providerId: result.providerId, model: result.model, promptVersion: result.promptVersion,
      observations: [], media: summaries, coverage: noneCoverage, failureKind: result.failureKind, message: result.message,
    };
  }
  await record(sql, scope, {
    id: runId, providerId: result.providerId, model: result.model, promptVersion: result.promptVersion, requestKey, status: "observed",
    media: summaries, observations: result.observations, coverage, latencyMs: result.latencyMs, usage: result.usage,
  });
  return {
    status: "observed", runId, reused: false, providerId: result.providerId, model: result.model, promptVersion: result.promptVersion,
    observations: result.observations, media: summaries, coverage,
  };
}

/**
 * The observations as text a decision can read. Each line names its media and real timestamp, and says it is a model's
 * description. It never says a measurement was made.
 */
export function groundedPerceptionText(outcome: PerceptionRunOutcome): string[] {
  if (outcome.status !== "observed") return [];
  const byId = new Map(outcome.media.map((item) => [item.id, item]));
  const lines = outcome.observations.map((observation) => {
    const media = byId.get(observation.mediaId);
    const where = observation.timestampMs !== null ? `Frame at ${observation.timestampMs}ms` : "Image";
    const facts = [
      observation.shotType ? `shot ${observation.shotType}` : null,
      observation.productPresence === undefined ? null : `product ${observation.productPresence ? "present" : "absent"}`,
      observation.facePresence === undefined ? null : `face ${observation.facePresence ? "present" : "absent"}`,
      observation.setting ? `setting ${observation.setting}` : null,
      observation.ocrText ? `on-screen text "${observation.ocrText}"` : null,
    ].filter((item): item is string => item !== null);
    return `${where} (${media?.label ?? observation.mediaId}, sha256 ${observation.sha256.slice(0, 12)}…): ${facts.join("; ") || "no detail reported"}. Model description from ${outcome.providerId} ${outcome.model}, prompt ${outcome.promptVersion}.`;
  });
  return [...lines, outcome.coverage.note];
}
