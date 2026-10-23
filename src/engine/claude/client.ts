// The W3 Claude client (Bible 11): one entry point, runRole, for every Claude role. A role call goes through the API gateway
// (structuredChat, OpenRouter by default, config/routes.ts), is authorized and reconciled against the request's budget
// reservation (paidCall, Bible 14.1), and returns a validated answer or a typed error. This file reads no keys, logs no
// prompts and calls no network: those belong to the gateway.
//
// Idempotency (Bible 14.1, CLAUDE.md rule 3): the key of a call is the hash of (role, prompt version, model, input). A key
// that was already authorized is never called again. runRole then returns status "duplicate" with the stored entry, and
// the caller uses the answer it stored (the artifact) rather than asking again.

import type { ZodType } from "zod";
import { budgets } from "../config/budgets.ts";
import type { BudgetAlert } from "../budget/reserve.ts";
import type { LedgerRow, LedgerStore } from "../budget/store.ts";
import { EngineError } from "../contracts/errors.ts";
import { contentHash } from "../contracts/hash.ts";
import { idSchema } from "../contracts/ids.ts";
import type { Gateway, ResolvedRoute } from "../gateway/gateway.ts";
import { paidCall } from "../gateway/paid.ts";
import { StructuredOutputError, structuredChat, type ChatMessage, type ChatUsage, type StructuredChatResult } from "../gateway/openrouter.ts";
import { loadPrompt } from "../prompts/load.ts";
import { RoleAnswerError } from "./errors.ts";
import { type JournalEntry, type RoleCall, type RoleCallJournal } from "./journal.ts";
import { estimateClaudeUsd, estimateFromPriceUsd } from "./rates.ts";
import type { RoleDefinition } from "./role.ts";

export type { JournalEntry, RoleCall, RoleCallJournal } from "./journal.ts";

/** The longest list of failed checks the retry shows the model (initial). The rest is counted, not listed. */
const MAX_RETRY_ISSUES = 20;

export type RoleDeps = {
  gateway: Gateway;
  ledger: LedgerStore;
  /** The clock, as an ISO time. It becomes the ledger entry's `at`. */
  now: () => string;
  /**
   * The persisted record of the calls (Bible 11, 14.1). Optional: without it nothing is stored and nothing is resumed. With it,
   * every paid call is written before it is made and after it settles, and a stored answer is reused instead of called again.
   */
  journal?: RoleCallJournal;
};

export type RoleRequest<Input> = {
  /** req_ id of the production request. Must match the reservation's request. */
  requestId: string;
  /** The tenant. It must match the reservation's workspace; the gateway uses it to pick the workspace's credential. */
  workspaceId: string;
  /** res_ id of the request's budget reservation. A call is made only against it. */
  reservationId: string;
  /**
   * The job's infrastructure attempt (Bible 5.1), from 1. The key does not include it: a call that returned no answer (a timeout or
   * a 5xx) keeps its hold on the ledger, and a retry of the job reuses the same key. The ledger returns the first authorization, so the
   * retry is never a second paid call (review 2026-10-22, item 1).
   */
  attempt?: number;
  signal?: AbortSignal;
  input: Input;
  /**
   * A model the user chose for this call, from the live catalog (the orchestrator, owner direction 2026-10-20). The call goes to it, and
   * the reservation is priced from its live price, not from the fixed rate table. Without it the route table decides, as before.
   */
  chosenModel?: { modelId: string; price: { promptUsdPerToken: number; completionUsdPerToken: number } };
};

type OutcomeBase = {
  role: string;
  promptVersion: string;
  /** Every call this run made, in order. A duplicate or refusal made none of them. */
  calls: RoleCall[];
  /**
   * Stored calls this run used instead of calling again (a resume, Bible 14.1): a reused answer, or the first answer that failed
   * its contract when only the retry was sent. They are already on the ledger and cost nothing now.
   */
  resumed: RoleCall[];
  alerts: BudgetAlert[];
};

export type RoleOutcome<Answer> = OutcomeBase &
  (
    | { status: "done"; value: Answer }
    /** The reservation does not cover the call (or is paused). No call was made. */
    | { status: "refused"; reason: string }
    /**
     * The key was already authorized, so no call was made. Use the stored answer. If the entry has no actual cost, the earlier
     * call returned no answer: a retry of the job gets this duplicate again and no answer, so it must not be read as one.
     */
    | { status: "duplicate"; entry: LedgerRow; samePayload: boolean }
  );

type Verdict<Answer> =
  | { verdict: "answered"; answer: StructuredChatResult<Answer> }
  | { verdict: "invalid"; issues: string[]; usage: ChatUsage | null };

type Settled<Answer> =
  | { status: "settled"; verdict: Verdict<Answer>; call: RoleCall; alerts: BudgetAlert[] }
  | { status: "refused"; reason: string; alerts: BudgetAlert[] }
  | { status: "duplicate"; entry: LedgerRow; samePayload: boolean };

type CallContext<Input, Answer> = {
  deps: RoleDeps;
  role: RoleDefinition<Input, Answer>;
  /** The request the call is for. It is part of the call's idempotency key. */
  requestId: string;
  workspaceId: string;
  reservationId: string;
  route: ResolvedRoute;
  promptVersion: string;
  estimateUsd: number;
  input: Input;
  answer: ZodType<Answer>;
  attempt: number;
  signal: AbortSignal | undefined;
};

function invalid(name: string, stage: string): EngineError {
  return new EngineError("invalid_input", `${name} is not valid for a role call`, { stage });
}

function requireId(prefix: "req_" | "res_", value: string, name: string, stage: string): string {
  const parsed = idSchema(prefix).safeParse(value);
  if (!parsed.success) throw invalid(`${name} (it must be a ${prefix} id)`, stage);
  return parsed.data;
}

function parseInput<Input>(schema: ZodType<Input>, role: string, input: unknown, stage: string): Input {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`);
    throw new EngineError("invalid_input", `${role} input does not match its contract: ${issues.join("; ")}`, { stage });
  }
  return parsed.data;
}

/**
 * The idempotency key of one call: the hash of (request, role, prompt version, model, input). A later infrastructure attempt of the job uses
 * the same key, so a call that OpenRouter billed before a timeout is never paid again: the ledger returns the first authorization, and the
 * client reports a duplicate and does not call (review 2026-10-22, item 1). The single quality retry adds the key of the call it retries,
 * because it is a second call on purpose.
 */
function callKey<Input, Answer>(ctx: CallContext<Input, Answer>, retryOf: string | undefined): string {
  return contentHash({
    // The request is part of the key: the same input in two requests is two calls, each paid and journaled for its own request.
    requestId: ctx.requestId,
    role: ctx.role.role,
    promptVersion: ctx.promptVersion,
    model: ctx.route.model,
    input: ctx.input,
    ...(retryOf === undefined ? {} : { retryOf }),
  });
}

/**
 * One paid call: authorize the key against the reservation, call the gateway once, and reconcile the ledger entry. A
 * StructuredOutputError is a settled answer (the call was billed, the answer failed its contract), so it reconciles to the
 * held estimate and is returned to runRole. Every other error throws and keeps its hold.
 */
async function settle<Input, Answer>(
  ctx: CallContext<Input, Answer>,
  messages: ChatMessage[],
  idempotencyKey: string,
  retryOfKey: string | undefined,
): Promise<Settled<Answer>> {
  const journal = (fields: Pick<JournalEntry, "status" | "call" | "answer" | "refusedReason">): Promise<void> =>
    recordJournal(ctx, { idempotencyKey, retryOfKey: retryOfKey ?? null, ...fields });

  const outcome = await paidCall<Verdict<Answer>>(
    {
      ledger: ctx.deps.ledger,
      reservationId: ctx.reservationId,
      stage: budgets.fixedStages.claudeRoles,
      route: ctx.route,
      estimateUsd: ctx.estimateUsd,
      idempotencyKey,
      at: ctx.deps.now(),
      role: ctx.role.role,
      promptVersion: ctx.promptVersion,
    },
    async () => {
      // Written before the network is asked, so a call that never came back is visible as pending. A failed write throws here,
      // before any request is sent.
      await journal({ status: "pending", call: null, answer: null, refusedReason: null });
      try {
        const answer = await structuredChat(ctx.deps.gateway, {
          organizationId: ctx.workspaceId,
          capability: ctx.role.capability,
          route: ctx.route,
          messages,
          schema: ctx.answer,
          schemaName: ctx.role.schemaName,
          maxTokens: ctx.role.maxOutputTokens,
          timeoutMs: ctx.role.timeoutMs,
          signal: ctx.signal,
          stage: ctx.role.stage,
        });
        return { value: { verdict: "answered", answer }, actualUsd: answer.usage.costUsd };
      } catch (error) {
        if (error instanceof StructuredOutputError) {
          // The call was billed even though the answer failed its contract. Use OpenRouter's bill when it reported one; otherwise the
          // hold stands, unsettled. No estimate is booked.
          return { value: { verdict: "invalid", issues: [...error.issues], usage: error.usage }, actualUsd: error.usage?.costUsd ?? null };
        }
        throw error;
      }
    },
  );

  if (outcome.status === "refused") {
    await journal({ status: "refused", call: null, answer: null, refusedReason: outcome.reason });
    return { status: "refused", reason: outcome.reason, alerts: outcome.alerts };
  }
  // A duplicate is not journaled here: its key is already on the ledger, and the journal holds whatever it stored.
  if (outcome.status === "duplicate") return { status: "duplicate", entry: outcome.entry, samePayload: outcome.samePayload };

  const { value, entry } = outcome;
  const answered = value.verdict === "answered" ? value.answer : null;
  const usage = value.verdict === "answered" ? value.answer.usage : value.usage;
  const call: RoleCall = {
    idempotencyKey,
    ledgerEntryId: entry.entryId,
    promptVersion: ctx.promptVersion,
    model: ctx.route.model,
    answeredBy: answered?.model ?? null,
    generationId: answered?.generationId ?? null,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    costUsd: usage?.costUsd ?? null,
    verdict: value.verdict === "answered" ? "answered" : "invalid_answer",
    issues: value.verdict === "invalid" ? [...value.issues] : [],
  };
  // The answer is stored before the caller sees it, so a job that crashes after this point resumes with the same answer.
  await journal(
    value.verdict === "answered"
      ? { status: "answered", call, answer: value.answer.value, refusedReason: null }
      : { status: "invalid_answer", call, answer: null, refusedReason: null },
  );
  return { status: "settled", verdict: value, call, alerts: outcome.alerts };
}

/** Writes one journal entry for this call, when the deps carry a journal. The role, version and model come from the context. */
async function recordJournal<Input, Answer>(
  ctx: CallContext<Input, Answer>,
  fields: Pick<JournalEntry, "idempotencyKey" | "retryOfKey" | "status" | "call" | "answer" | "refusedReason">,
): Promise<void> {
  if (ctx.deps.journal === undefined) return;
  await ctx.deps.journal.record({
    ...fields,
    role: ctx.role.role,
    stage: ctx.role.stage,
    promptVersion: ctx.promptVersion,
    model: ctx.route.model,
    reservationId: ctx.reservationId,
  });
}

/** The stored answer of a key, or null. Without a journal there is nothing stored. */
async function storedCall(deps: RoleDeps, idempotencyKey: string): Promise<JournalEntry | null> {
  return deps.journal === undefined ? null : deps.journal.find(idempotencyKey);
}

/**
 * A stored answer, checked again against the role's contract before it is used. The stored text is data: a row that no longer
 * matches is an internal error, and no call is made to replace it.
 */
function reusedAnswer<Input, Answer>(ctx: CallContext<Input, Answer>, stored: JournalEntry): Answer {
  const parsed = ctx.answer.safeParse(stored.answer);
  if (!parsed.success) {
    throw new EngineError("internal", `the stored answer of ${ctx.role.role} no longer matches its contract; no call is made`, {
      stage: ctx.role.stage,
    });
  }
  return parsed.data;
}

/**
 * The single retry (Bible 11). It names the failed checks by path and code and states the role's rule. The model's discarded
 * answer is not sent back: only the checks are.
 */
function retryMessage(rule: string, issues: readonly string[]): string {
  const shown = issues.slice(0, MAX_RETRY_ISSUES).map((issue) => `- ${issue}`);
  const hidden = issues.length > MAX_RETRY_ISSUES ? [`- and ${issues.length - MAX_RETRY_ISSUES} more`] : [];
  return [
    "The previous answer did not match the output contract, so it was discarded. The checks it failed are listed by path and code only:",
    ...shown,
    ...hidden,
    `Rule to meet: ${rule}`,
    "Answer again from the same inputs with one JSON object that matches the output contract, and nothing else.",
  ].join("\n");
}

/**
 * Run one role call (Bible 11). Order of work:
 * 1. Validate the ids and the input. A bad input is refused before anything is reserved.
 * 2. Check the reservation belongs to this request and workspace (a mismatch is not found, so nothing leaks across tenants).
 * 3. Route the capability and check the provider is connected. A call with no key sends nothing and holds nothing.
 * 4. Price the call (the role's token estimate at the routed model's rate) and authorize it on the reservation.
 * 5. Call once. An answer that fails the contract gets exactly one retry, under its own key, with the failed checks appended.
 * 6. A second failure throws RoleAnswerError, and the stage fails.
 *
 * `status: "refused"` and `status: "duplicate"` are returned, not thrown: the request pauses or the caller reuses the answer.
 */
export async function runRole<Input, Answer>(
  deps: RoleDeps,
  role: RoleDefinition<Input, Answer>,
  request: RoleRequest<Input>,
): Promise<RoleOutcome<Answer>> {
  const stage = role.stage;
  const requestId = requireId("req_", request.requestId, "requestId", stage);
  const reservationId = requireId("res_", request.reservationId, "reservationId", stage);
  if (request.workspaceId.length === 0) throw invalid("workspaceId", stage);
  const attempt = request.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) throw invalid("attempt (it must be an integer from 1)", stage);
  const input = parseInput(role.input, role.role, request.input, stage);

  const reservation = await deps.ledger.getReservation(reservationId);
  if (reservation === null || reservation.workspaceId !== request.workspaceId || reservation.requestId !== requestId) {
    throw new EngineError("not_found", `no reservation ${reservationId} for this request in this workspace; no call is made`, { stage });
  }

  const route = request.chosenModel === undefined ? deps.gateway.route(role.capability) : deps.gateway.chosen(role.capability, request.chosenModel.modelId);
  const connection = await deps.gateway.connection(route.provider.id, request.workspaceId);
  if (!connection.connected) {
    throw new EngineError(
      "config",
      `${route.provider.id} is not connected for this workspace (${connection.reason ?? "no credential"}); no call is made`,
      { stage },
    );
  }

  const prompt = loadPrompt(role.prompt);
  const ctx: CallContext<Input, Answer> = {
    requestId,
    deps,
    role,
    workspaceId: request.workspaceId,
    reservationId,
    route,
    promptVersion: prompt.id,
    estimateUsd:
      request.chosenModel === undefined
        ? estimateClaudeUsd(route.model, role.estimateTokens)
        : estimateFromPriceUsd(request.chosenModel.price, role.estimateTokens),
    input,
    answer: role.answer(input),
    attempt,
    signal: request.signal,
  };
  const base: ChatMessage[] = [
    { role: "system", content: prompt.text },
    { role: "user", content: role.userContent(input) },
  ];
  const head = { role: role.role, promptVersion: prompt.id };
  const calls: RoleCall[] = [];
  const resumed: RoleCall[] = [];
  const alerts: BudgetAlert[] = [];

  // Resume (Bible 14.1). A stored answer is reused without a call. A stored first answer that failed its contract was billed,
  // so only its retry is sent. Anything else (no entry, a refusal, or a call that was started and never came back) is called
  // as usual: a started call is a duplicate on the ledger, so it makes no second call and reports as duplicate.
  const firstKey = callKey(ctx, undefined);
  const storedFirst = await storedCall(deps, firstKey);
  if (storedFirst?.status === "answered" && storedFirst.call !== null) {
    resumed.push(storedFirst.call);
    return { ...head, status: "done", value: reusedAnswer(ctx, storedFirst), calls, resumed, alerts };
  }

  let failedIssues: string[];
  let failedKey: string;
  if (storedFirst?.status === "invalid_answer" && storedFirst.call !== null) {
    resumed.push(storedFirst.call);
    failedIssues = [...storedFirst.call.issues];
    failedKey = firstKey;
  } else {
    const first = await settle(ctx, base, firstKey, undefined);
    if (first.status === "refused") return { ...head, status: "refused", reason: first.reason, calls, resumed, alerts: first.alerts };
    if (first.status === "duplicate") {
      return { ...head, status: "duplicate", entry: first.entry, samePayload: first.samePayload, calls, resumed, alerts };
    }
    calls.push(first.call);
    alerts.push(...first.alerts);
    if (first.verdict.verdict === "answered") {
      return { ...head, status: "done", value: first.verdict.answer.value, calls, resumed, alerts };
    }
    failedIssues = first.verdict.issues;
    failedKey = first.call.idempotencyKey;
  }

  const retryKey = callKey(ctx, failedKey);
  const storedRetry = await storedCall(deps, retryKey);
  if (storedRetry?.status === "answered" && storedRetry.call !== null) {
    resumed.push(storedRetry.call);
    return { ...head, status: "done", value: reusedAnswer(ctx, storedRetry), calls, resumed, alerts };
  }
  if (storedRetry?.status === "invalid_answer" && storedRetry.call !== null) {
    // The stage already failed its one retry. Resuming it makes no call and fails it again with the same checks.
    resumed.push(storedRetry.call);
    throw new RoleAnswerError(role.role, calls.length + resumed.length, [...storedRetry.call.issues], stage);
  }

  const retryMessages: ChatMessage[] = [...base, { role: "user", content: retryMessage(role.retryRule, failedIssues) }];
  const retry = await settle(ctx, retryMessages, retryKey, failedKey);
  if (retry.status === "refused") {
    return { ...head, status: "refused", reason: retry.reason, calls, resumed, alerts: [...alerts, ...retry.alerts] };
  }
  if (retry.status === "duplicate") {
    return { ...head, status: "duplicate", entry: retry.entry, samePayload: retry.samePayload, calls, resumed, alerts };
  }
  calls.push(retry.call);
  alerts.push(...retry.alerts);
  if (retry.verdict.verdict === "answered") {
    return { ...head, status: "done", value: retry.verdict.answer.value, calls, resumed, alerts };
  }
  throw new RoleAnswerError(role.role, calls.length + resumed.length, retry.verdict.issues, stage);
}
