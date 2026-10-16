// The Postgres store of Claude role calls (Video Engine Bible 11 and 14.1), on engine_role_calls (migration 0078). The client
// (claude/client.ts) writes one journal entry per call through the RoleCallJournal port, and reads it back before it calls, so
// a resumed job reuses a stored answer or sends only the retry (see the client's runRole). This file implements that port for
// one request, and reads the records the manifest needs.
//
// Tenancy: every query is scoped to the organization and the request. A key that another workspace or request holds is not
// visible here, so nothing is reused across tenants.

import { randomUUID } from "node:crypto";
import { EngineError } from "../contracts/index.ts";
import { JOURNAL_STATUSES, type JournalEntry, type JournalStatus, type RoleCall, type RoleCallJournal } from "../claude/journal.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

export type RoleCallScope = { organizationId: string; requestId: string };

type RoleCallRow = {
  idempotency_key: string;
  retry_of_key: string | null;
  role: string;
  stage: string;
  prompt_version: string;
  model: string;
  reservation_id: string;
  status: JournalStatus;
  ledger_entry_id: string | null;
  answer: string | null;
  answered_by: string | null;
  generation_id: string | null;
  prompt_tokens: number | string | null;
  completion_tokens: number | string | null;
  cost_usd: number | string | null;
  issues: string;
  refused_reason: string | null;
};

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStored(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new EngineError("internal", `the stored ${what} of a role call is not JSON`, { cause: error });
  }
}

function storedIssues(text: string): string[] {
  const parsed = parseStored(text, "issues");
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new EngineError("internal", "the stored issues of a role call are not a list of strings");
  }
  return parsed;
}

function rowToEntry(row: RoleCallRow, scope: RoleCallScope): JournalEntry {
  const settled = row.status === "answered" || row.status === "invalid_answer";
  const call: RoleCall | null =
    settled && row.ledger_entry_id !== null
      ? {
          idempotencyKey: row.idempotency_key,
          ledgerEntryId: row.ledger_entry_id,
          promptVersion: row.prompt_version,
          model: row.model,
          answeredBy: row.answered_by,
          generationId: row.generation_id,
          promptTokens: toNumber(row.prompt_tokens),
          completionTokens: toNumber(row.completion_tokens),
          costUsd: toNumber(row.cost_usd),
          verdict: row.status === "answered" ? "answered" : "invalid_answer",
          issues: storedIssues(row.issues),
        }
      : null;
  if (settled && call === null) {
    throw new EngineError("internal", `the role call ${row.idempotency_key} of ${scope.requestId} has no ledger entry`);
  }
  return {
    status: row.status,
    idempotencyKey: row.idempotency_key,
    retryOfKey: row.retry_of_key,
    role: row.role,
    stage: row.stage,
    promptVersion: row.prompt_version,
    model: row.model,
    reservationId: row.reservation_id,
    call,
    answer: row.status === "answered" && row.answer !== null ? parseStored(row.answer, "answer") : null,
    refusedReason: row.refused_reason,
  };
}

/** Refuses an entry that does not fit its status, before anything is written. */
function checkEntry(entry: JournalEntry): void {
  const invalid = (message: string): never => {
    throw new EngineError("invalid_input", `role call journal entry ${entry.idempotencyKey}: ${message}`, { stage: entry.stage });
  };
  if (!(JOURNAL_STATUSES as readonly string[]).includes(entry.status)) invalid("unknown status");
  if (entry.idempotencyKey.length === 0) invalid("the idempotency key is empty");
  if (entry.reservationId.length === 0) invalid("the reservation is empty");
  if (entry.status === "pending" && (entry.call !== null || entry.answer !== null)) invalid("a pending call has no answer yet");
  if (entry.status === "answered") {
    if (entry.call === null || entry.call.verdict !== "answered") invalid("an answered call needs its RoleCall with verdict answered");
    if (entry.answer === null || entry.answer === undefined) invalid("an answered call needs its validated answer");
  }
  if (entry.status === "invalid_answer") {
    if (entry.call === null || entry.call.verdict !== "invalid_answer") invalid("an invalid answer needs its RoleCall with verdict invalid_answer");
    if (entry.answer !== null) invalid("an invalid answer is not stored");
  }
  if (entry.status === "refused" && (entry.refusedReason === null || entry.refusedReason.length === 0)) {
    invalid("a refusal needs its reason");
  }
}

/**
 * The journal of one request. find returns the entry stored for a key of this request, or null. record upserts the entry: a
 * pending or refused row may move on to a later status, and an answered or invalid row is never changed.
 */
export function sqlRoleCallJournal(sql: Sql, scope: RoleCallScope): RoleCallJournal {
  return {
    async find(idempotencyKey) {
      const rows = await sql<RoleCallRow>`
        select idempotency_key, retry_of_key, role, stage, prompt_version, model, reservation_id, status, ledger_entry_id, answer,
          answered_by, generation_id, prompt_tokens, completion_tokens, cost_usd, issues, refused_reason
        from engine_role_calls
        where organization_id = ${scope.organizationId} and request_id = ${scope.requestId} and idempotency_key = ${idempotencyKey}
        limit 1
      `;
      const row = rows[0];
      return row ? rowToEntry(row, scope) : null;
    },

    async record(entry) {
      checkEntry(entry);
      const call = entry.call;
      await sql`
        insert into engine_role_calls (id, organization_id, request_id, reservation_id, stage, role, prompt_version, model,
          idempotency_key, retry_of_key, status, ledger_entry_id, answer, answered_by, generation_id, prompt_tokens,
          completion_tokens, cost_usd, issues, refused_reason, updated_at)
        values (${randomUUID()}, ${scope.organizationId}, ${scope.requestId}, ${entry.reservationId}, ${entry.stage}, ${entry.role},
          ${entry.promptVersion}, ${entry.model}, ${entry.idempotencyKey}, ${entry.retryOfKey}, ${entry.status},
          ${call?.ledgerEntryId ?? null}, ${entry.status === "answered" ? JSON.stringify(entry.answer) : null},
          ${call?.answeredBy ?? null}, ${call?.generationId ?? null}, ${call?.promptTokens ?? null}, ${call?.completionTokens ?? null},
          ${call?.costUsd ?? null}, ${JSON.stringify(call?.issues ?? [])},
          ${entry.refusedReason}, now())
        on conflict (organization_id, request_id, idempotency_key) do update set
          status = excluded.status,
          ledger_entry_id = excluded.ledger_entry_id,
          answer = excluded.answer,
          answered_by = excluded.answered_by,
          generation_id = excluded.generation_id,
          prompt_tokens = excluded.prompt_tokens,
          completion_tokens = excluded.completion_tokens,
          cost_usd = excluded.cost_usd,
          issues = excluded.issues,
          refused_reason = excluded.refused_reason,
          updated_at = now()
        where engine_role_calls.status in ('pending', 'refused')
      `;
    },
  };
}

/** Every journal entry of a request, in the order the calls were first attempted. For a review, a resume or a test. */
export async function listRoleCalls(sql: Sql, scope: RoleCallScope): Promise<JournalEntry[]> {
  const rows = await sql<RoleCallRow>`
    select idempotency_key, retry_of_key, role, stage, prompt_version, model, reservation_id, status, ledger_entry_id, answer,
      answered_by, generation_id, prompt_tokens, completion_tokens, cost_usd, issues, refused_reason
    from engine_role_calls
    where organization_id = ${scope.organizationId} and request_id = ${scope.requestId}
    order by seq asc
  `;
  return rows.map((row) => rowToEntry(row, scope));
}

/**
 * The RoleCall records the manifest carries (Bible 11): every call that was billed, answered or not, in order. A refused call
 * was never billed and a pending call has no answer to record, so neither is listed. Their state is still in listRoleCalls.
 */
export function manifestRoleCalls(entries: readonly JournalEntry[]): RoleCall[] {
  return entries.flatMap((entry) => (entry.call === null ? [] : [entry.call]));
}

/**
 * The prompt version of each role the request used (Manifest.promptVersions, Bible 11.3). A role that ran with two versions in
 * one request is refused: the manifest would name only one of them.
 */
export function promptVersionsOf(entries: readonly JournalEntry[]): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.status === "refused") continue;
    const seen = versions[entry.role];
    if (seen !== undefined && seen !== entry.promptVersion) {
      throw new EngineError("internal", `the role ${entry.role} ran with two prompt versions (${seen}, ${entry.promptVersion}) in one request`, {
        stage: entry.stage,
      });
    }
    versions[entry.role] = entry.promptVersion;
  }
  return versions;
}
