// The request feed: the status of every node, shot and artifact of a request, read for the Factory and the review inbox. Moved
// out of engine/api/index.ts unchanged (coding loop, T8). index.ts re-exports the public names.

import { z } from "zod";
import { edlSchema, manifestSchema, productionRequestSchema, writtenScriptSchema, renderedVideoSchema, roundUsd, scenePlanSchema, takeSchema, takeVerdictSchema, validatedRequestSchema, videoDnaSchema, voiceTrackSchema } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { readArtifact } from "../jobs/artifact-store.ts";
import { readEngineRequest } from "../jobs/orchestrator-sql.ts";
import { routes } from "../config/routes.ts";
import { remakeRefusalOf, type OrchestratorState } from "../jobs/orchestrator.ts";
import { engineRequestStatus } from "./start.ts";
import type { EngineRequestStatus } from "./start.ts";

// --- Request feed ----------------------------------------------------------------------------------------------------------
//
// What the engine recorded for one request, read only, for a screen that shows each decision as it happens (Content Factory). Every
// value comes from an engine store: the request's state, its artifacts (read back through their contracts), its gate results, its
// decisions, its ledger, its reservation and its stage jobs. Nothing is derived that the stores do not hold: a cost with no bill is
// null, a model with no record is absent, and an unknown is never filled in. Tenancy: every read names the workspace.

export type FeedNodeStatus = "idle" | "queued" | "passed";

export type FeedJobCounts = { queued: number; running: number; retry: number; succeeded: number; dead: number };

export type FeedGate = {
  gate: string;
  subjectId: string;
  pass: boolean;
  /** Rule names with their code-written detail (Bible 12). */
  checks: { rule: string; pass: boolean; detail: string | null }[];
  failingShotIds: string[];
  at: string;
};

export type FeedDecision = { at: string; chose: string; alternatives: { option: string; score: number }[]; reason: string; by: string; recordedAt: string };

export type FeedLedgerRow = {
  stage: string;
  provider: string;
  model: string;
  /** The list estimate the call was written with (Bible 14.1). */
  estimateUsd: number;
  reservedUsd: number;
  /** A verified bill, 0 for a call the provider confirmed created no job, or null while neither is known (contract v6). */
  actualUsd: number | null;
  settlement: "billed" | "confirmed_absent" | null;
  at: string;
};

/** A shot's model, as the plan records it (Bible 10.5, contract v7 modelChoice). Absent until the shot spec carries one. */

export type FeedModelChoice = { model: string; provider: string | null; reason: string | null; catalogReadAt: string | null };

export type FeedShot = {
  shotId: string;
  beatId: string;
  startMs: number;
  endMs: number;
  visualType: string;
  layer: string;
  sourceKind: string;
  /** The model classes the shot's source calls (one for a generate source, one per call for a chain, none for code or stock). */
  modelClasses: string[];
  modelChoice: FeedModelChoice | null;
  /** The route table's targets for the shot's first model class, in priority order. A null model is an id not set yet. */
  routeTargets: { provider: string; model: string | null }[];
  /** The orchestrator's status for the shot, when it is tracked. */
  status: string | null;
};

export type FeedArtifact =
  | { type: "production_request"; artifactId: string; createdAt: string; language: string | null; beats: { beatId: string; role: string; text: string }[]; brief: string | null; referenceVideo: string; keep: string[]; change: string[]; maxMs: number; budgetUsd: number }
  | { type: "validated_request"; artifactId: string; createdAt: string; estimatedSpeechMs: number }
  | { type: "written_script"; artifactId: string; createdAt: string; language: string; beats: { beatId: string; role: string; text: string }[]; rationale: string }
  | { type: "video_dna"; artifactId: string; createdAt: string; durationMs: number; segments: number; transcriptWords: number; genes: string[]; transferable: string[]; sourceDeletedAt: string | null }
  | { type: "voice_track"; artifactId: string; createdAt: string; voiceId: string; provider: string; durationMs: number; lufs: number; words: number }
  | { type: "scene_plan"; artifactId: string; createdAt: string; planId: string; estimatedUsd: number; shots: FeedShot[]; decisions: FeedDecision[] }
  | { type: "take"; artifactId: string; createdAt: string; takeId: string; shotId: string; attempt: number; provider: string; model: string; durationMs: number }
  | { type: "take_verdict"; artifactId: string; createdAt: string; takeId: string; pass: boolean; action: string; confidence: number; failing: string[] }
  | { type: "edl"; artifactId: string; createdAt: string; edlId: string; durationMs: number; clips: number; variantOf: string | null }
  | { type: "rendered_video"; artifactId: string; createdAt: string; videoId: string; renderer: string; durationMs: number; bytes: number; estimateUsd: number; costUsd: number | null }
  | { type: "manifest"; artifactId: string; createdAt: string; videoId: string; variantOf: string | null; shots: { shotId: string; provider: string; model: string }[] }
  | { type: "other"; artifactId: string; createdAt: string; artifactType: string; stage: string };

export type EngineRequestFeed = {
  requestId: string;
  status: EngineRequestStatus;
  currentStage: string;
  cachedDna: boolean;
  pause: { kind: string; stage: string; reason: string } | null;
  nodes: Record<string, FeedNodeStatus>;
  branches: { edlId: string; variantOf: string | null; stage: string; status: string }[];
  jobs: Record<string, FeedJobCounts>;
  artifacts: FeedArtifact[];
  gates: FeedGate[];
  decisions: FeedDecision[];
  ledger: FeedLedgerRow[];
  reservation: { state: string; estimateUsd: number; reservedUsd: number; pausedReason: string | null } | null;
  openReviewItems: number;
  /** How many times a person has remade a shot of this video (Bible 5.5). 0 for the first delivery. */
  revision: number;
  /** One row per shot of the plan, in time order. The board draws each shot from its row. */
  shots: FeedShotRow[];
};

/**
 * A shot as the board shows it (Bible 5.5). Unknown values stay null: a shot with no plan record has no timing. `remakeRefusal` says why a
 * remake is not possible now, or is null when it is.
 */
export type FeedShotRow = {
  shotId: string;
  beatId: string | null;
  startMs: number | null;
  endMs: number | null;
  visualType: string | null;
  sourceKind: string | null;
  status: "pending" | "accepted" | "replanning" | "escalated";
  /** The produce round of the shot's current attempt, starting at 0. */
  round: number;
  /** How many times a person has remade this shot. */
  remakes: number;
  /** The takes of the shot's current plan, across its rounds, that still count. */
  takes: number;
  acceptedTakeId: string | null;
  /** The newest verdict of the shot's current takes: pass or fail, and the rule names of the failing checks. */
  lastVerdict: { pass: boolean; failing: string[] } | null;
  /** The reviewer's directions for the shot, oldest first. */
  directives: string[];
  remakeRefusal: string | null;
};

const modelChoiceSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  modelId: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(100).optional(),
  reason: z.string().min(1).max(2000).optional(),
  catalogReadAt: z.string().min(1).max(60).optional(),
});

/** The modelChoice of each shot in a stored plan body, by shot id. A plan written before contract v7 has none. */

function modelChoicesOf(body: string): Map<string, FeedModelChoice> {
  const choices = new Map<string, FeedModelChoice>();
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return choices;
  }
  const shots = (raw as { shots?: unknown }).shots;
  if (!Array.isArray(shots)) return choices;
  for (const shot of shots as Array<{ shotId?: unknown; modelChoice?: unknown }>) {
    if (typeof shot?.shotId !== "string" || shot.modelChoice === undefined) continue;
    const parsed = modelChoiceSchema.safeParse(shot.modelChoice);
    const model = parsed.success ? (parsed.data.model ?? parsed.data.modelId) : undefined;
    if (!parsed.success || model === undefined) continue;
    choices.set(shot.shotId, { model, provider: parsed.data.provider ?? null, reason: parsed.data.reason ?? null, catalogReadAt: parsed.data.catalogReadAt ?? null });
  }
  return choices;
}

function routeTargetsOf(modelClass: string | undefined): { provider: string; model: string | null }[] {
  if (modelClass === undefined) return [];
  const route = (routes.table as Record<string, { targets: readonly { provider: string; model: string | null }[] } | undefined>)[modelClass];
  return route ? route.targets.map((target) => ({ provider: target.provider, model: target.model })) : [];
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function feedArtifactOf(stored: Awaited<ReturnType<typeof readArtifact>>, stage: string, rawBody: string, shotStatus: Record<string, string>): FeedArtifact {
  const { envelope } = stored;
  const base = { artifactId: envelope.artifactId, createdAt: envelope.createdAt };
  const body = envelope.body;
  switch (envelope.type) {
    case "production_request": {
      const request = productionRequestSchema.parse(body);
      return {
        type: "production_request",
        ...base,
        // Contract v8: a request carries its own script or a brief; a brief's script arrives later as the written_script artifact.
        language: request.script?.language ?? null,
        beats: request.script?.beats.map((beat) => ({ beatId: beat.beatId, role: beat.role, text: beat.text })) ?? [],
        brief: request.brief?.text ?? null,
        referenceVideo: request.format.referenceVideo,
        keep: request.format.keep,
        change: request.format.change,
        maxMs: request.constraints.maxMs,
        budgetUsd: request.constraints.budgetUsd,
      };
    }
    case "written_script": {
      const script = writtenScriptSchema.parse(body);
      return {
        type: "written_script",
        ...base,
        language: script.language,
        beats: script.beats.map((beat) => ({ beatId: beat.beatId, role: beat.role, text: beat.text })),
        rationale: script.rationale,
      };
    }
    case "validated_request":
      return { type: "validated_request", ...base, estimatedSpeechMs: validatedRequestSchema.parse(body).estimatedSpeechMs };
    case "video_dna": {
      const dna = videoDnaSchema.parse(body);
      return {
        type: "video_dna",
        ...base,
        durationMs: dna.durationMs,
        segments: dna.segments.length,
        transcriptWords: dna.transcript.words.length,
        genes: Object.keys(dna.genome),
        transferable: dna.transferable,
        sourceDeletedAt: dna.sourceDeletedAt ?? null,
      };
    }
    case "voice_track": {
      const voice = voiceTrackSchema.parse(body);
      return { type: "voice_track", ...base, voiceId: voice.voiceId, provider: voice.provider, durationMs: voice.durationMs, lufs: voice.lufs, words: voice.words.length };
    }
    case "scene_plan": {
      const plan = scenePlanSchema.parse(body);
      const choices = modelChoicesOf(rawBody);
      return {
        type: "scene_plan",
        ...base,
        planId: plan.planId,
        estimatedUsd: plan.estimatedUsd,
        shots: plan.shots.map((shot) => {
          const modelClasses = shot.source.kind === "generate" ? [shot.source.modelClass] : shot.source.kind === "chain" ? shot.source.calls.map((call) => call.modelClass) : [];
          return {
            shotId: shot.shotId,
            beatId: shot.beatId,
            startMs: shot.startMs,
            endMs: shot.endMs,
            visualType: shot.visualType,
            layer: shot.layer,
            sourceKind: shot.source.kind,
            modelClasses,
            modelChoice: choices.get(shot.shotId) ?? null,
            routeTargets: routeTargetsOf(modelClasses[0]),
            status: shotStatus[shot.shotId] ?? null,
          };
        }),
        decisions: plan.decisions.map((decision) => ({ ...decision, recordedAt: envelope.createdAt })),
      };
    }
    case "take": {
      const take = takeSchema.parse(body);
      return { type: "take", ...base, takeId: take.takeId, shotId: take.shotId, attempt: take.attempt, provider: take.provider, model: take.model, durationMs: take.durationMs };
    }
    case "take_verdict": {
      const verdict = takeVerdictSchema.parse(body);
      return {
        type: "take_verdict",
        ...base,
        takeId: verdict.takeId,
        pass: verdict.pass,
        action: verdict.action,
        confidence: verdict.confidence,
        failing: verdict.checks.filter((check) => !check.pass).map((check) => check.rule),
      };
    }
    case "edl": {
      const edl = edlSchema.parse(body);
      return { type: "edl", ...base, edlId: edl.edlId, durationMs: edl.durationMs, clips: edl.tracks.reduce((sum, track) => sum + track.clips.length, 0), variantOf: edl.variantOf ?? null };
    }
    case "rendered_video": {
      const video = renderedVideoSchema.parse(body);
      return { type: "rendered_video", ...base, videoId: video.videoId, renderer: video.renderer, durationMs: video.durationMs, bytes: video.bytes, estimateUsd: video.estimateUsd, costUsd: video.costUsd };
    }
    case "manifest": {
      const manifest = manifestSchema.parse(body);
      return { type: "manifest", ...base, videoId: manifest.videoId, variantOf: manifest.variantOf ?? null, shots: manifest.shots.map((shot) => ({ shotId: shot.shotId, provider: shot.provider, model: shot.model })) };
    }
    default:
      return { type: "other", ...base, artifactType: envelope.type, stage };
  }
}

function jsonList<T>(text: string): T[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

const emptyCounts = (): FeedJobCounts => ({ queued: 0, running: 0, retry: 0, succeeded: 0, dead: 0 });

/**
 * Everything the engine recorded for one request of a workspace, in the order it was recorded, or null when the workspace has no such
 * request. Read only: nothing is written, queued or called.
 */
/** The board's rows for the shots of a request: the plan's timing, the orchestrator's shot state and its takes (Bible 5.5). */

async function feedShotsOf(sql: Sql, organizationId: string, state: OrchestratorState): Promise<FeedShotRow[]> {
  const planId = state.artifacts.plan;
  const parsed = planId === undefined ? null : scenePlanSchema.safeParse((await readArtifact(sql, { organizationId, artifactId: planId })).envelope.body);
  const specs = new Map((parsed?.success ? parsed.data.shots : []).map((spec) => [spec.shotId, spec]));
  const takes = Object.values(state.takes);
  const rows = Object.values(state.shots).map((shot): FeedShotRow => {
    const spec = specs.get(shot.shotId);
    const current = takes.filter((take) => take.shotId === shot.shotId && take.epoch === shot.epoch && !take.stale);
    const newest = current.filter((take) => take.verdict !== null).at(-1)?.verdict ?? null;
    return {
      shotId: shot.shotId,
      beatId: spec?.beatId ?? null,
      startMs: spec?.startMs ?? null,
      endMs: spec?.endMs ?? null,
      visualType: spec?.visualType ?? null,
      sourceKind: spec?.source.kind ?? null,
      status: shot.status,
      round: shot.round,
      remakes: shot.remakes ?? 0,
      takes: current.length,
      acceptedTakeId: shot.acceptedTakeId,
      lastVerdict: newest === null ? null : { pass: newest.pass, failing: [...newest.failing] },
      directives: [...(shot.directives ?? [])],
      remakeRefusal: remakeRefusalOf(state, shot.shotId),
    };
  });
  return rows.sort((a, b) => (a.startMs ?? Number.MAX_SAFE_INTEGER) - (b.startMs ?? Number.MAX_SAFE_INTEGER) || a.shotId.localeCompare(b.shotId));
}

export async function engineRequestFeed(sql: Sql, organizationId: string, requestId: string): Promise<EngineRequestFeed | null> {
  const read = await readEngineRequest(sql, organizationId, requestId);
  if (!read) return null;
  const status = await engineRequestStatus(sql, organizationId, requestId);
  if (!status) return null;
  const state = read.state;

  const shotStatus: Record<string, string> = Object.fromEntries(Object.entries(state.shots).map(([shotId, shot]) => [shotId, shot.status]));
  const artifactRows = await sql<{ id: string; stage: string; body: string }>`
    select id, stage, body from engine_artifacts
    where organization_id = ${organizationId} and request_id = ${requestId}
    order by created_at asc, id asc
  `;
  const artifacts: FeedArtifact[] = [];
  for (const row of artifactRows) {
    const stored = await readArtifact(sql, { organizationId, artifactId: row.id });
    artifacts.push(feedArtifactOf(stored, row.stage, row.body, shotStatus));
  }

  const gateRows = await sql<{ gate: string; subject_id: string; passed: boolean; checks: string; failing_shot_ids: string; created_at: unknown }>`
    select gate, subject_id, passed, checks, failing_shot_ids, created_at from engine_gate_results
    where organization_id = ${organizationId} and request_id = ${requestId}
    order by created_at asc, id asc
  `;
  const gates: FeedGate[] = gateRows.map((row) => ({
    gate: row.gate,
    subjectId: row.subject_id,
    pass: row.passed === true,
    checks: jsonList<{ rule?: unknown; pass?: unknown; detail?: unknown }>(row.checks)
      .filter((check) => typeof check.rule === "string")
      .map((check) => ({ rule: check.rule as string, pass: check.pass === true, detail: typeof check.detail === "string" && check.detail ? check.detail.slice(0, 500) : null })),
    failingShotIds: jsonList<unknown>(row.failing_shot_ids).filter((id): id is string => typeof id === "string"),
    at: iso(row.created_at),
  }));

  const decisionRows = await sql<{ at: string; chose: string; alternatives: string; reason: string; decided_by: string; created_at: unknown }>`
    select at, chose, alternatives, reason, decided_by, created_at from engine_decisions
    where organization_id = ${organizationId} and request_id = ${requestId}
    order by created_at asc, id asc
  `;
  const decisions: FeedDecision[] = decisionRows.map((row) => ({
    at: row.at,
    chose: row.chose,
    alternatives: jsonList<{ option?: unknown; score?: unknown }>(row.alternatives)
      .filter((item) => typeof item.option === "string" && typeof item.score === "number")
      .map((item) => ({ option: item.option as string, score: item.score as number })),
    reason: row.reason,
    by: row.decided_by,
    recordedAt: iso(row.created_at),
  }));

  const ledgerRows = await sql<{ stage: string; provider: string; model: string; estimate_usd: string | number; reserved_usd: string | number; actual_usd: string | number | null; settlement: string | null; at: unknown }>`
    select stage, provider, model, estimate_usd, reserved_usd, actual_usd, settlement, at from engine_ledger
    where organization_id = ${organizationId} and request_id = ${requestId}
    order by at asc, id asc
  `;
  const ledger: FeedLedgerRow[] = ledgerRows.map((row) => ({
    stage: row.stage,
    provider: row.provider,
    model: row.model,
    estimateUsd: roundUsd(Number(row.estimate_usd)),
    reservedUsd: roundUsd(Number(row.reserved_usd)),
    actualUsd: row.actual_usd === null || row.settlement === null ? null : roundUsd(Number(row.actual_usd)),
    settlement: row.settlement === "billed" || row.settlement === "confirmed_absent" ? row.settlement : null,
    at: iso(row.at),
  }));

  const reservationId = state.budgetReservationId;
  const reservationRows = reservationId === null
    ? []
    : await sql<{ state: string; estimate_usd: string | number; reserved_usd: string | number; paused_reason: string | null }>`
        select state, estimate_usd, reserved_usd, paused_reason from engine_reservations
        where organization_id = ${organizationId} and id = ${reservationId} limit 1
      `;
  const reservationRow = reservationRows[0];

  const jobs: Record<string, FeedJobCounts> = {};
  const prefix = `engine:${requestId}:`;
  const jobRows = await sql<{ job_type: string; status: string; n: number }>`
    select job_type, status, count(*)::int as n from jobs
    where organization_id = ${organizationId} and left(idempotency_key, ${prefix.length}::int) = ${prefix}
    group by job_type, status
  `;
  for (const row of jobRows) {
    const stage = row.job_type.startsWith("engine.") ? row.job_type.slice("engine.".length) : row.job_type;
    const counts = jobs[stage] ?? emptyCounts();
    if (row.status === "queued" || row.status === "running" || row.status === "retry" || row.status === "succeeded" || row.status === "dead") {
      counts[row.status] += Number(row.n);
    }
    jobs[stage] = counts;
  }

  const open = await sql<{ n: number }>`
    select count(*)::int as n from engine_review_items
    where organization_id = ${organizationId} and request_id = ${requestId} and status = 'open'
  `;

  return {
    requestId,
    status,
    currentStage: read.currentStage,
    cachedDna: state.cachedDna,
    pause: state.pause === null ? null : { kind: state.pause.kind, stage: state.pause.stage, reason: state.pause.reason },
    nodes: Object.fromEntries(Object.entries(state.nodes).map(([node, value]) => [node, value.status])),
    branches: Object.values(state.branches).map((branch) => ({ edlId: branch.edlId, variantOf: branch.variantOf, stage: branch.stage, status: branch.status })),
    jobs,
    artifacts,
    gates,
    decisions,
    ledger,
    reservation: reservationRow
      ? {
          state: reservationRow.state,
          estimateUsd: roundUsd(Number(reservationRow.estimate_usd)),
          reservedUsd: roundUsd(Number(reservationRow.reserved_usd)),
          pausedReason: reservationRow.paused_reason,
        }
      : null,
    openReviewItems: Number(open[0]?.n ?? 0),
    revision: state.revision ?? 0,
    shots: await feedShotsOf(sql, organizationId, state),
  };
}

/** The production readiness ports: Meridian's Settings, its credential resolver and the worker's engine runtime. */
