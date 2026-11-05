// Direction scripts for a draft (docs/direction/INTEGRATION.md, step 2): the Create page's Scripts panel and the agent tools use these
// functions, so a person and an agent write, regenerate and choose scripts the same way.
//
// - Ask for options: a direction run (pipeline.ts, `choose: "person"`) is queued as a job. The worker runs it once (a paid run is never
//   retried by itself), through the live port: every model call holds and settles the workspace's budget (live.server.ts). The brief is
//   the draft's instructions and sources, the brand's brain gives its claims, forbidden terms, tone and audience, and the hooks to avoid
//   are the brand's started hooks and this draft's earlier options, so a new run brings new ideas.
// - Regenerate: a revision of one script with an optional note from the person (`reviseDirectedScript`): the new version keeps the
//   concept, and its parent is the script it revises. A fresh idea is a new run for one option.
// - Choose: the script's lines become the draft's script lines (the engine then uses them and skips write_script), with one note of
//   pictures, words on screen and sound. Choosing another replaces them. A script with a blocking finding cannot be chosen.
//
// Every function checks the caller is an admin of the draft's workspace (sessionAccess), and every query is scoped to that workspace.
// Nothing here calls a provider: only the job does, through the port it is given.

import { randomUUID } from "node:crypto";
import { BRIEF_LIST_MAX, BRIEF_TEXT_MAX } from "../../../engine/contracts/request.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { audit, lockDraft, requireDraft, sessionAccess, type SessionRow } from "../content-factory/service-core.ts";
import { getSession, messagesOf } from "../content-factory/service-sessions.ts";
import { briefSources } from "../content-factory/request.ts";
import { readStartedHooks } from "../content-factory/hook-history-store.ts";
import { MAX_SECONDS, MIN_SECONDS, type SessionDetail } from "../content-factory/model.ts";
import { linesOf, loadFactoryBrain } from "../factory/brain-facts.ts";
import type { GenerationDeps } from "../providers/chat.server.ts";
import { storedGenerationModel } from "../settings/generation-models.ts";
import { DIRECTION_CODEX_VERSION, NICHE_FAMILIES, VIDEO_JOBS, type NicheFamily, type VideoJob } from "./codex.ts";
import type { Concept } from "./concepts.ts";
import { liveDirectionPort, type LiveDirectionContext } from "./live.server.ts";
import { DEFAULT_DIRECTION_SETTINGS, attemptShips, reviseDirectedScript, runDirection, type DirectionPort, type DirectionRequest, type DirectionSettings, type ScriptAttempt } from "./pipeline.ts";
import { hookLine } from "./report.ts";
import { directionSeats, type DirectionSeats, type SeatsOutcome } from "./seats.ts";
import { directionNoteOf, scriptCard, scriptLinesOf, type ScriptCard } from "./scripts-view.ts";

export const DIRECTION_JOB_WRITE = "direction.write";
export const DIRECTION_JOB_REVISE = "direction.revise";

/** How many options one run may write. */
export const MAX_OPTIONS = 4;
/** The longest note a person may give a revision. */
export const NOTE_MAX = 600;
/** A revision's hard limit on model calls: two rounds of a draft and its swipe test, each with one retry. */
export const REVISE_CALL_LIMIT = 8;
/** How many rounds a revision may take before it stops and shows what it has. */
export const REVISE_ROUNDS = 2;

/** A run's hard limit on model calls, for `count` options: the concept lab, the panel's pairs in both orders, and each option's drafts. */
export function writeCallLimit(count: number): number {
  return 18 + 7 * count;
}

/** The pipeline's settings for a run that writes `count` options for a person to choose from. */
export function writeSettings(count: number, seats: Pick<DirectionSeats, "writers" | "judge" | "director">, seed: string): DirectionSettings {
  return {
    writers: seats.writers,
    judge: seats.judge,
    director: seats.director,
    conceptCalls: count === 1 ? 2 : DEFAULT_DIRECTION_SETTINGS.conceptCalls,
    conceptsPerCall: count === 1 ? 4 : DEFAULT_DIRECTION_SETTINGS.conceptsPerCall,
    opponents: DEFAULT_DIRECTION_SETTINGS.opponents,
    finalists: count,
    maxRevisions: DEFAULT_DIRECTION_SETTINGS.maxRevisions,
    maxCalls: writeCallLimit(count),
    seed,
    choose: "person",
  };
}

export type WriteAsk = { sessionId: string; count: number; job: VideoJob; niche: NicheFamily | null; maxSeconds: number; language: string };
export type ReviseAsk = { sessionId: string; scriptId: string; note: string };

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/** Refuses an ask the pipeline cannot run, in words a person can act on. */
export function checkWriteAsk(ask: WriteAsk): void {
  if (!Number.isInteger(ask.count) || ask.count < 1 || ask.count > MAX_OPTIONS) throw new Error(`Ask for 1 to ${MAX_OPTIONS} scripts.`);
  if (!(VIDEO_JOBS as readonly string[]).includes(ask.job)) throw new Error("Choose the video's job: reach, follow or convert.");
  if (ask.niche !== null && !(NICHE_FAMILIES as readonly string[]).includes(ask.niche)) throw new Error("Choose a niche from the list, or none.");
  if (!Number.isInteger(ask.maxSeconds) || ask.maxSeconds < MIN_SECONDS || ask.maxSeconds > MAX_SECONDS) {
    throw new Error(`Set a length from ${MIN_SECONDS} to ${MAX_SECONDS} seconds.`);
  }
  if (!LANGUAGE.test(ask.language)) throw new Error("Set the script's language as a tag, for example en or pt-BR.");
}

/** The ports a test replaces. Production: the stored task models, the live catalogue and the live port. */
export type DirectionPorts = {
  modelDeps?: GenerationDeps;
  port?: (context: LiveDirectionContext) => DirectionPort;
};

function storedFor(sql: Sql, deps: GenerationDeps | undefined): NonNullable<GenerationDeps["stored"]> {
  return deps?.stored ?? ((organizationId, task) => storedGenerationModel(sql, organizationId, task));
}

/** The seats a run in this workspace would use, checked now. Admins of the draft's workspace only. */
export async function directionSeatsOf(sql: Sql, userId: string, input: { sessionId: string }, ports: DirectionPorts = {}): Promise<SeatsOutcome> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  return directionSeats(row.organization_id, storedFor(sql, ports.modelDeps), ports.modelDeps);
}

// --- The request ---------------------------------------------------------------------------------------------------------

type ScriptRow = {
  id: string;
  run_id: string;
  parent_id: string | null;
  version: number;
  rank: number | null;
  concept_id: string;
  concept: string;
  attempts: string;
  ships: boolean;
  blocked: boolean;
  state: string;
  posted_message_ids: string;
  created_at: unknown;
};

function parsed<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function idsOf(text: string): string[] {
  const value = parsed<unknown>(text, []);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function scriptRowsOf(sql: Sql, row: SessionRow): Promise<ScriptRow[]> {
  return sql<ScriptRow>`
    select id, run_id, parent_id, version, rank, concept_id, concept, attempts, ships, blocked, state, posted_message_ids, created_at
    from direction_scripts
    where organization_id = ${row.organization_id} and session_id = ${row.id}
    order by created_at desc, id
  `;
}

function lastScriptOf(row: ScriptRow): ScriptAttempt | null {
  const attempts = parsed<ScriptAttempt[]>(row.attempts, []);
  return attempts.at(-1) ?? null;
}

/** A script's ancestors and itself: the hooks a revision may keep. */
function lineageOf(rows: ScriptRow[], scriptId: string): Set<string> {
  const byId = new Map(rows.map((item) => [item.id, item]));
  const lineage = new Set<string>();
  let current = byId.get(scriptId);
  while (current && !lineage.has(current.id)) {
    lineage.add(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return lineage;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The direction request for a draft: its instructions and sources as the brief (leaving out the notes a chosen script posted), the
 * brand's brain, and the hooks to avoid. A draft with no instruction has no brief, and is refused.
 */
export async function directionRequestFor(
  sql: Sql,
  row: SessionRow,
  ask: Pick<WriteAsk, "job" | "niche" | "maxSeconds" | "language">,
  keepHooksOf: Set<string> = new Set(),
): Promise<DirectionRequest> {
  const scripts = await scriptRowsOf(sql, row);
  const posted = new Set(scripts.flatMap((script) => idsOf(script.posted_message_ids)));
  const messages = (await messagesOf(sql, row)).filter((message) => !posted.has(message.id));
  const text = messages
    .filter((message) => message.beatRole === null)
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) throw new Error("Say what the video is for in the chat first: the scripts are written from your instructions and the material you attach.");
  const sources = briefSources(messages.flatMap((message) => message.attachments)).slice(0, BRIEF_LIST_MAX);

  let brand: DirectionRequest["brand"] = { name: "", claims: [], forbidden: [] };
  let audience: string | undefined;
  const avoid: string[] = [];
  if (row.brand_id) {
    const named = await sql<{ name: string }>`
      select name from brands where id = ${row.brand_id} and organization_id = ${row.organization_id} and deleted_at is null limit 1
    `;
    const brain = (await loadFactoryBrain(sql, row.organization_id, row.brand_id)).values;
    const tone = [brain.tone, brain.writingStyle].map((value) => value.trim()).filter(Boolean).join(" ");
    brand = {
      name: named[0]?.name ?? "",
      claims: [...linesOf(brain.proofPoints), ...linesOf(brain.requiredClaims)].slice(0, 24).map((line) => clip(line, 300)),
      forbidden: [...linesOf(brain.wordsToAvoid), ...linesOf(brain.prohibitedClaims)].slice(0, 40).map((line) => clip(line, 160)),
      ...(tone ? { tone: clip(tone, 600) } : {}),
    };
    const who = [
      brain.targetCustomers && `Who: ${brain.targetCustomers}`,
      brain.problems && `Problems: ${brain.problems}`,
      brain.desires && `Desires: ${brain.desires}`,
      brain.objections && `Objections: ${brain.objections}`,
    ].filter(Boolean);
    if (who.length > 0) audience = clip(who.join("\n"), 1500);
    for (const started of await readStartedHooks(sql, row.organization_id, row.brand_id)) if (started.hook) avoid.push(started.hook);
  }
  for (const script of scripts) {
    if (keepHooksOf.has(script.id)) continue;
    const last = lastScriptOf(script);
    const hook = last ? hookLine(last.script) : null;
    if (hook) avoid.push(hook);
  }
  return {
    brief: { text: clip(text, BRIEF_TEXT_MAX), sources },
    brand,
    ...(audience ? { audience } : {}),
    ...(ask.niche ? { niche: ask.niche } : {}),
    language: ask.language,
    maxDurationMs: ask.maxSeconds * 1000,
    recentHooks: [...new Set(avoid)].slice(0, 60),
    // Discovery's dated trends are not joined yet (INTEGRATION.md step 2), so a run is told of none and may use none.
    trends: [],
    job: ask.job,
  };
}

// --- Asking for a run ----------------------------------------------------------------------------------------------------

async function requireNoActiveRun(sql: Sql, row: SessionRow): Promise<void> {
  const active = await sql<{ id: string }>`
    select r.id from direction_runs r
    left join jobs j on j.id = r.job_id and j.organization_id = r.organization_id
    where r.organization_id = ${row.organization_id} and r.session_id = ${row.id} and r.status in ('queued', 'running')
      and (j.id is null or j.status in ('queued', 'running', 'retry'))
    limit 1
  `;
  if (active[0]) throw new Error("A direction run is already working on this draft. Wait for it to finish.");
}

async function queueRun(
  sql: Sql,
  row: SessionRow,
  userId: string,
  input: { kind: "write" | "revise"; ask: Record<string, unknown>; request: DirectionRequest; callLimit: number },
): Promise<{ runId: string }> {
  const runId = randomUUID();
  const jobId = randomUUID();
  const jobType = input.kind === "write" ? DIRECTION_JOB_WRITE : DIRECTION_JOB_REVISE;
  await withTransaction(sql, async (tx) => {
    await lockDraft(tx, row);
    // Checked again under the draft's lock, so two asks at the same moment cannot both queue a run.
    await requireNoActiveRun(tx, row);
    await tx`
      insert into direction_runs (id, organization_id, brand_id, session_id, kind, status, job_id, ask, request, codex_version, call_limit, created_by)
      values (${runId}, ${row.organization_id}, ${row.brand_id}, ${row.id}, ${input.kind}, 'queued', ${jobId}, ${JSON.stringify(input.ask)},
        ${JSON.stringify(input.request)}, ${DIRECTION_CODEX_VERSION}, ${input.callLimit}, ${userId})
    `;
    // One attempt: the run spends from the workspace's budget, so it is never retried without a person asking again.
    await tx`
      insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts)
      values (${jobId}, ${row.organization_id}, ${row.brand_id}, ${jobType}, ${`direction:${runId}`}, 'queued',
        ${JSON.stringify({ organizationId: row.organization_id, runId })}, 1)
    `;
  });
  await audit(sql, {
    organizationId: row.organization_id,
    brandId: row.brand_id,
    actorId: userId,
    action: `direction.${input.kind}.queued`,
    objectId: row.id,
    metadata: { runId, callLimit: String(input.callLimit) },
  });
  return { runId };
}

/** Queues a run that writes `count` script options for the draft. Refused, with the reason, before anything is queued or spent. */
export async function askForScripts(sql: Sql, userId: string, ask: WriteAsk, ports: DirectionPorts = {}): Promise<{ runId: string; callLimit: number }> {
  const row = await sessionAccess(sql, userId, ask.sessionId);
  requireDraft(row);
  checkWriteAsk(ask);
  await requireNoActiveRun(sql, row);
  const seats = await directionSeats(row.organization_id, storedFor(sql, ports.modelDeps), ports.modelDeps);
  if (!seats.ok) throw new Error(seats.reason);
  const request = await directionRequestFor(sql, row, ask);
  const callLimit = writeCallLimit(ask.count);
  const { runId } = await queueRun(sql, row, userId, {
    kind: "write",
    ask: { count: ask.count, job: ask.job, niche: ask.niche, maxSeconds: ask.maxSeconds, language: ask.language },
    request,
    callLimit,
  });
  return { runId, callLimit };
}

/** Queues a revision of one script, with the person's note. The revision keeps the script's concept and its run's settings. */
export async function askForRevision(sql: Sql, userId: string, ask: ReviseAsk, ports: DirectionPorts = {}): Promise<{ runId: string; callLimit: number }> {
  const row = await sessionAccess(sql, userId, ask.sessionId);
  requireDraft(row);
  const note = ask.note.trim();
  if (note.length > NOTE_MAX) throw new Error(`Keep a note to ${NOTE_MAX} characters.`);
  const scripts = await scriptRowsOf(sql, row);
  const script = scripts.find((item) => item.id === ask.scriptId);
  if (!script) throw new Error("That script is not in this draft.");
  await requireNoActiveRun(sql, row);
  const seats = await directionSeats(row.organization_id, storedFor(sql, ports.modelDeps), ports.modelDeps);
  if (!seats.ok) throw new Error(seats.reason);
  const origin = await sql<{ ask: string }>`
    select r.ask from direction_runs r
    where r.organization_id = ${row.organization_id} and r.id = ${script.run_id} limit 1
  `;
  const first = parsed<Partial<WriteAsk>>(origin[0]?.ask ?? "{}", {});
  if (first.job === undefined || first.maxSeconds === undefined || first.language === undefined) {
    throw new Error("The run that wrote this script did not record its settings, so it cannot be revised. Ask for a new script instead.");
  }
  const settings = { job: first.job, niche: first.niche ?? null, maxSeconds: first.maxSeconds, language: first.language };
  checkWriteAsk({ sessionId: row.id, count: 1, ...settings });
  const request = await directionRequestFor(sql, row, settings, lineageOf(scripts, script.id));
  const { runId } = await queueRun(sql, row, userId, {
    kind: "revise",
    ask: { scriptId: script.id, note, ...settings },
    request,
    callLimit: REVISE_CALL_LIMIT,
  });
  return { runId, callLimit: REVISE_CALL_LIMIT };
}

// --- The job -------------------------------------------------------------------------------------------------------------

type RunRow = {
  id: string;
  organization_id: string;
  brand_id: string | null;
  session_id: string;
  kind: string;
  status: string;
  ask: string;
  request: string;
};

async function finishRun(
  sql: Sql,
  run: RunRow,
  outcome: { status: "ready" | "needs_person" | "failed"; reasons: string[]; notes?: string[]; prompts?: Record<string, string>; record?: unknown; calls?: number; costUsd?: number | null },
): Promise<void> {
  await sql`
    update direction_runs set
      status = ${outcome.status}, reasons = ${JSON.stringify(outcome.reasons)}, notes = ${JSON.stringify(outcome.notes ?? [])},
      prompts = ${JSON.stringify(outcome.prompts ?? {})}, record = ${JSON.stringify(outcome.record ?? {})}, calls = ${outcome.calls ?? 0},
      cost_usd = ${outcome.costUsd ?? null}, finished_at = now()
    where id = ${run.id} and organization_id = ${run.organization_id}
  `;
}

async function insertScript(
  sql: Sql,
  run: RunRow,
  input: { parentId: string | null; version: number; rank: number | null; concept: Concept; attempts: ScriptAttempt[] },
): Promise<string> {
  const id = randomUUID();
  const last = input.attempts.at(-1)!;
  await sql`
    insert into direction_scripts (id, organization_id, session_id, run_id, parent_id, version, rank, concept_id, concept, attempts, ships, blocked)
    values (${id}, ${run.organization_id}, ${run.session_id}, ${run.id}, ${input.parentId}, ${input.version}, ${input.rank}, ${input.concept.id},
      ${JSON.stringify(input.concept)}, ${JSON.stringify(input.attempts)}, ${attemptShips(last)}, ${last.report.blocked})
  `;
  return id;
}

/**
 * Runs one queued direction job (the worker, jobs/execute.ts). A run that is no longer queued is left alone. A model failure never
 * throws: it is recorded and shapes the run's status. Anything else marks the run failed with its reason, then throws, so the job shows it.
 */
export async function executeDirectionJob(sql: Sql, job: ExecutableJob, payload: Record<string, unknown>, ports: DirectionPorts = {}): Promise<string> {
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  const rows = await sql<RunRow>`
    select id, organization_id, brand_id, session_id, kind, status, ask, request
    from direction_runs where id = ${runId} and organization_id = ${job.organization_id} limit 1
  `;
  const run = rows[0];
  if (!run) throw new Error("The direction run of this job was not found in its workspace.");
  if (run.status !== "queued") return `direction:${run.status}`;
  const claimed = await sql<{ id: string }>`
    update direction_runs set status = 'running' where id = ${run.id} and organization_id = ${run.organization_id} and status = 'queued' returning id
  `;
  if (!claimed[0]) return "direction:taken";

  try {
    const seats = await directionSeats(run.organization_id, storedFor(sql, ports.modelDeps), ports.modelDeps);
    if (!seats.ok) {
      await finishRun(sql, run, { status: "failed", reasons: [`${seats.reason} Nothing was sent.`] });
      return "direction:failed";
    }
    const port = (ports.port ?? liveDirectionPort)({
      organizationId: run.organization_id,
      brandId: run.brand_id,
      sql,
      correlationId: run.id,
      inputRef: `content_factory_session:${run.session_id}`,
      slots: seats.seats.slots,
    });
    const request = parsed<DirectionRequest | null>(run.request, null);
    if (!request) throw new Error("The run's stored request could not be read.");
    const ask = parsed<Record<string, unknown>>(run.ask, {});

    if (run.kind === "write") {
      const count = typeof ask.count === "number" ? ask.count : 1;
      const result = await runDirection(request, port, writeSettings(count, seats.seats, run.id));
      for (const option of result.options) {
        await insertScript(sql, run, { parentId: null, version: 1, rank: option.rank, concept: option.concept, attempts: option.attempts });
      }
      await finishRun(sql, run, {
        status: result.status,
        reasons: result.reasons,
        notes: result.notes,
        prompts: result.prompts,
        record: {
          deck: result.deck,
          obvious: result.obvious,
          concepts: result.concepts,
          dropped: result.dropped,
          ranking: result.ranking,
          conceptReliability: result.conceptReliability,
          finalists: result.finalists.map((record) => ({ conceptId: record.conceptId, drafts: record.attempts.length, ...(record.error ? { error: record.error } : {}) })),
          suggestion: result.chosen?.conceptId ?? null,
          seats: seats.seats.view,
          calls: result.calls,
        },
        calls: result.calls.length,
        costUsd: result.costUsd,
      });
      return `direction:${result.status}:${result.options.length}`;
    }

    const scriptId = typeof ask.scriptId === "string" ? ask.scriptId : "";
    const parents = await sql<ScriptRow>`
      select id, run_id, parent_id, version, rank, concept_id, concept, attempts, ships, blocked, state, posted_message_ids, created_at
      from direction_scripts where id = ${scriptId} and organization_id = ${run.organization_id} and session_id = ${run.session_id} limit 1
    `;
    const parent = parents[0];
    const draft = parent ? lastScriptOf(parent) : null;
    const concept = parent ? parsed<Concept | null>(parent.concept, null) : null;
    if (!parent || !draft || !concept) {
      await finishRun(sql, run, { status: "failed", reasons: ["The script to revise is no longer in this draft. Nothing was sent."] });
      return "direction:failed";
    }
    const note = typeof ask.note === "string" ? ask.note : "";
    const revision = await reviseDirectedScript(
      { request, concept, draft, note },
      port,
      { director: seats.seats.director, judge: seats.seats.judge, maxCalls: REVISE_CALL_LIMIT, rounds: REVISE_ROUNDS },
    );
    let newId: string | null = null;
    if (revision.attempts.length > 0) {
      newId = await insertScript(sql, run, {
        parentId: parent.id,
        version: parent.version + 1,
        rank: parent.rank,
        concept,
        attempts: revision.attempts,
      });
    }
    await finishRun(sql, run, {
      status: revision.status,
      reasons: revision.reasons,
      prompts: revision.prompts,
      record: { parentId: parent.id, scriptId: newId, note, seats: seats.seats.view, calls: revision.calls },
      calls: revision.calls.length,
      costUsd: revision.costUsd,
    });
    return `direction:${revision.status}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The run stopped with an unknown error.";
    await finishRun(sql, run, { status: "failed", reasons: [`The run stopped with an error: ${clip(message, 300)}`] });
    throw error;
  }
}

// --- Reading -------------------------------------------------------------------------------------------------------------

export type RunCard = {
  id: string;
  kind: "write" | "revise";
  status: "queued" | "running" | "ready" | "needs_person" | "failed";
  reasons: string[];
  notes: string[];
  ask: { count: number | null; job: string | null; scriptId: string | null; note: string | null };
  calls: number;
  callLimit: number;
  /** The provider-reported cost. Null while it runs, and when any call's cost is unknown. */
  costUsd: number | null;
  createdAt: string;
  finishedAt: string | null;
  /** How the concepts were narrowed: written, dropped (with why), and the ideas every writer would reach. */
  concepts: { written: number; kept: number; obvious: string[]; dropped: Array<{ reason: string }>; reliability: number | null } | null;
};

export type DirectionPanel = {
  draft: boolean;
  runs: RunCard[];
  scripts: ScriptCard[];
  /** True while a run is queued or running: the panel polls until it is not. */
  working: boolean;
};

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

function runStatus(status: string, jobStatus: string | null): RunCard["status"] {
  if ((status === "queued" || status === "running") && jobStatus !== null && !["queued", "running", "retry"].includes(jobStatus)) return "failed";
  return (["queued", "running", "ready", "needs_person", "failed"] as const).find((value) => value === status) ?? "failed";
}

/** The draft's direction runs and scripts, newest first. Admins of the draft's workspace only. */
export async function directionPanelOf(sql: Sql, userId: string, input: { sessionId: string }): Promise<DirectionPanel> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  const runRows = await sql<{
    id: string;
    kind: string;
    status: string;
    reasons: string;
    notes: string;
    ask: string;
    record: string;
    calls: number;
    call_limit: number;
    cost_usd: string | number | null;
    created_at: unknown;
    finished_at: unknown;
    job_status: string | null;
    job_error: string | null;
  }>`
    select r.id, r.kind, r.status, r.reasons, r.notes, r.ask, r.record, r.calls, r.call_limit, r.cost_usd, r.created_at, r.finished_at,
      j.status as job_status, j.last_error as job_error
    from direction_runs r
    left join jobs j on j.id = r.job_id and j.organization_id = r.organization_id
    where r.organization_id = ${row.organization_id} and r.session_id = ${row.id}
    order by r.created_at desc, r.id
    limit 20
  `;
  const runs = runRows.map((item): RunCard => {
    const status = runStatus(item.status, item.job_status);
    const reasons = idsOf(item.reasons);
    if (status === "failed" && item.status !== "failed") reasons.push(`The worker stopped before the run finished${item.job_error ? `: ${clip(item.job_error, 200)}` : "."}`);
    const ask = parsed<Record<string, unknown>>(item.ask, {});
    const record = parsed<Record<string, unknown>>(item.record, {});
    const concepts = Array.isArray(record.concepts)
      ? {
          written: (record.concepts as unknown[]).length + (Array.isArray(record.dropped) ? (record.dropped as unknown[]).length : 0),
          kept: (record.concepts as unknown[]).length,
          obvious: Array.isArray(record.obvious) ? (record.obvious as unknown[]).filter((line): line is string => typeof line === "string") : [],
          dropped: Array.isArray(record.dropped)
            ? (record.dropped as Array<Record<string, unknown>>).map((drop) => ({ reason: typeof drop.reason === "string" ? drop.reason : "" }))
            : [],
          reliability:
            record.conceptReliability && typeof (record.conceptReliability as Record<string, unknown>).consistency === "number"
              ? ((record.conceptReliability as Record<string, unknown>).consistency as number)
              : null,
        }
      : null;
    const cost = item.cost_usd === null ? null : Number(item.cost_usd);
    return {
      id: item.id,
      kind: item.kind === "revise" ? "revise" : "write",
      status,
      reasons,
      notes: idsOf(item.notes),
      ask: {
        count: typeof ask.count === "number" ? ask.count : null,
        job: typeof ask.job === "string" ? ask.job : null,
        scriptId: typeof ask.scriptId === "string" ? ask.scriptId : null,
        note: typeof ask.note === "string" && ask.note ? ask.note : null,
      },
      calls: Number(item.calls),
      callLimit: Number(item.call_limit),
      costUsd: cost !== null && Number.isFinite(cost) ? cost : null,
      createdAt: new Date(item.created_at as string).toISOString(),
      finishedAt: isoOrNull(item.finished_at),
      concepts,
    };
  });
  const scripts = (await scriptRowsOf(sql, row)).flatMap((item) => {
    const concept = parsed<Concept | null>(item.concept, null);
    if (!concept) return [];
    const card = scriptCard({
      id: item.id,
      runId: item.run_id,
      parentId: item.parent_id,
      version: Number(item.version),
      rank: item.rank === null ? null : Number(item.rank),
      state: item.state,
      createdAt: new Date(item.created_at as string).toISOString(),
      concept,
      attempts: parsed<ScriptAttempt[]>(item.attempts, []),
    });
    return card ? [card] : [];
  });
  return { draft: row.status === "draft", runs, scripts, working: runs.some((run) => run.status === "queued" || run.status === "running") };
}

// --- Choosing ------------------------------------------------------------------------------------------------------------

/**
 * Makes one script the draft's script: its lines become the draft's script lines, with one direction note, and the draft's language
 * becomes the script's. Choosing another script replaces the lines and the note this one posted. Refused for a script with a blocking
 * finding, and for a draft that already has script lines a person wrote, so nothing a person wrote is mixed or lost.
 */
export async function chooseScript(sql: Sql, userId: string, input: { sessionId: string; scriptId: string }): Promise<SessionDetail> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  requireDraft(row);
  await withTransaction(sql, async (tx) => {
    await lockDraft(tx, row);
    const scripts = await tx<ScriptRow & { run_ask: string }>`
      select s.id, s.run_id, s.parent_id, s.version, s.rank, s.concept_id, s.concept, s.attempts, s.ships, s.blocked, s.state,
        s.posted_message_ids, s.created_at, r.ask as run_ask
      from direction_scripts s
      join direction_runs r on r.id = s.run_id and r.organization_id = s.organization_id
      where s.organization_id = ${row.organization_id} and s.session_id = ${row.id} and (s.id = ${input.scriptId} or s.state = 'chosen')
      for update of s
    `;
    const script = scripts.find((item) => item.id === input.scriptId);
    if (!script) throw new Error("That script is not in this draft.");
    if (script.state === "chosen") return;
    const last = lastScriptOf(script);
    if (!last) throw new Error("That script has no draft to use.");
    if (script.blocked) throw new Error("This script has a blocking finding. Regenerate it with a note, or choose another.");
    const lines = scriptLinesOf(last.script);
    if (lines.length === 0) throw new Error("This script has no spoken line, so it cannot be the draft's script.");

    const previous = scripts.find((item) => item.state === "chosen");
    const replaced = previous ? idsOf(previous.posted_message_ids) : [];
    const handWritten = await tx<{ n: number }>`
      select count(*)::int as n from content_factory_messages
      where organization_id = ${row.organization_id} and session_id = ${row.id} and beat_role is not null
        and id not in (select jsonb_array_elements_text(${JSON.stringify(replaced)}::jsonb))
    `;
    if (Number(handWritten[0]?.n ?? 0) > 0) {
      throw new Error("This draft already has script lines written by hand. A chosen script would mix with them, so start a new draft to use it.");
    }
    if (previous) {
      await tx`
        delete from content_factory_messages
        where organization_id = ${row.organization_id} and session_id = ${row.id}
          and id in (select jsonb_array_elements_text(${JSON.stringify(replaced)}::jsonb))
      `;
      await tx`
        update direction_scripts set state = 'option', posted_message_ids = '[]', chosen_at = null, chosen_by = null
        where id = ${previous.id} and organization_id = ${row.organization_id}
      `;
    }
    const posted: string[] = [];
    // Each line gets its own time, a millisecond apart, so the draft keeps the script's order (messages are read by time).
    for (const [index, line] of lines.entries()) {
      const id = randomUUID();
      posted.push(id);
      await tx`
        insert into content_factory_messages (id, organization_id, session_id, author_id, text, beat_role, created_at)
        values (${id}, ${row.organization_id}, ${row.id}, ${userId}, ${line.text}, ${line.role}, now() + ${index}::int * interval '1 millisecond')
      `;
    }
    const noteId = randomUUID();
    posted.push(noteId);
    const label = `option ${script.rank ?? "?"}, version ${script.version}`;
    await tx`
      insert into content_factory_messages (id, organization_id, session_id, author_id, text, beat_role, created_at)
      values (${noteId}, ${row.organization_id}, ${row.id}, ${userId}, ${directionNoteOf(last.script, label)}, null,
        now() + ${lines.length}::int * interval '1 millisecond')
    `;
    await tx`
      update direction_scripts set state = 'chosen', posted_message_ids = ${JSON.stringify(posted)}, chosen_at = now(), chosen_by = ${userId}
      where id = ${script.id} and organization_id = ${row.organization_id}
    `;
    const ask = parsed<Partial<WriteAsk>>(script.run_ask, {});
    const seconds = typeof ask.maxSeconds === "number" ? ask.maxSeconds : null;
    await tx`
      update content_factory_sessions set language = ${last.script.language}, max_seconds = coalesce(max_seconds, ${seconds}), updated_at = now()
      where id = ${row.id} and organization_id = ${row.organization_id} and status = 'draft'
    `;
  });
  await audit(sql, { organizationId: row.organization_id, brandId: row.brand_id, actorId: userId, action: "direction.script.chosen", objectId: row.id, metadata: { scriptId: input.scriptId } });
  return getSession(sql, userId, { sessionId: row.id });
}
