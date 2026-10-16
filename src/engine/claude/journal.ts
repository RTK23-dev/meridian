// The record of Claude role calls (Video Engine Bible 11, 14.1). The client writes one journal entry for each paid call it makes
// and for each call the budget refused; the store in jobs/role-call-store.ts keeps them in engine_role_calls. The client reads
// the journal before it calls, so a resumed job reuses a stored answer instead of paying for the same call again.
//
// This file holds types and the port only. It imports nothing that does I/O, so claude/ never depends on jobs/.

/** One paid call of a role, as recorded for the manifest. The ledger row holds the money; this holds the rest. */
export type RoleCall = {
  idempotencyKey: string;
  ledgerEntryId: string;
  /** For example "segmenter@1" (Manifest.promptVersions). */
  promptVersion: string;
  /** The routed model (config/routes.ts). */
  model: string;
  /** The model OpenRouter says answered; it can differ from the routed one on a fallback. Null when there was no answer. */
  answeredBy: string | null;
  generationId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** OpenRouter's usage.cost. Null when the provider reported none, or the answer was invalid with no usage. */
  costUsd: number | null;
  verdict: "answered" | "invalid_answer";
  /** Paths and codes of the checks an invalid answer failed. Never the model's text. */
  issues: string[];
};

export const JOURNAL_STATUSES = ["pending", "answered", "invalid_answer", "refused"] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

/**
 * One journal entry. `pending`: authorized, and the gateway is about to be asked (no answer yet). `answered` and
 * `invalid_answer`: the call settled, with its RoleCall, and `answer` holds the validated answer (answered only). `refused`:
 * the reservation did not cover the call, so no ledger row and no call exist; `refusedReason` says why.
 */
export type JournalEntry = {
  status: JournalStatus;
  idempotencyKey: string;
  /** The key of the first call this call retries (the single quality retry), or null. */
  retryOfKey: string | null;
  role: string;
  stage: string;
  promptVersion: string;
  model: string;
  reservationId: string;
  call: RoleCall | null;
  answer: unknown | null;
  refusedReason: string | null;
};

/**
 * The journal the client uses. Scoped to one request by its implementation. `find` returns the stored entry for a key, or null.
 * `record` is idempotent on the key: an entry that already holds an answer is never changed.
 */
export interface RoleCallJournal {
  find(idempotencyKey: string): Promise<JournalEntry | null>;
  record(entry: JournalEntry): Promise<void>;
}
