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
import { estimateClaudeUsd } from "./rates.ts";
import type { RoleDefinition } from "./role.ts";

/** The longest list of failed checks the retry shows the model (initial). The rest is counted, not listed. */
const MAX_RETRY_ISSUES = 20;

export type RoleDeps = {
  gateway: Gateway;
  ledger: LedgerStore;
  /** The clock, as an ISO time. It becomes the ledger entry's `at`. */
  now: () => string;
};

export type RoleRequest<Input> = {
  /** req_ id of the production request. Must match the reservation's request. */
  requestId: string;
  /** The tenant. It must match the reservation's workspace; the gateway uses it to pick the workspace's credential. */
  workspaceId: string;
  /** res_ id of the request's budget reservation. A call is made only against it. */
  reservationId: string;
  /**
   * The job's infrastructure attempt (Bible 5.1), from 1. A call that returned no answer (a timeout or a 5xx) keeps its hold
   * on the ledger, and its key cannot be used again. The job retries it with the next attempt number, which is a new key.
   */
  attempt?: number;
  signal?: AbortSignal;
  input: Input;
};

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
  /** OpenRouter's usage.cost. Null when the provider reported none, or the answer was invalid (its usage is not kept). */
  costUsd: number | null;
  /** True when the ledger holds the estimate instead of a bill (a null cost, or an invalid answer). */
  actualIsEstimate: boolean;
  verdict: "answered" | "invalid_answer";
  /** Paths and codes of the checks an invalid answer failed. Never the model's text. */
  issues: string[];
};

type OutcomeBase = {
  role: string;
  promptVersion: string;
  /** Every call made by this run, in order. A duplicate or refusal made none of them. */
  calls: RoleCall[];
  alerts: BudgetAlert[];
};

export type RoleOutcome<Answer> = OutcomeBase &
  (
    | { status: "done"; value: Answer }
    /** The reservation does not cover the call (or is paused). No call was made. */
    | { status: "refused"; reason: string }
    /**
     * The key was already authorized, so no call was made. Use the stored answer. If the entry has no actual cost, the earlier
     * call returned no answer and the job may retry with a higher attempt number.
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
 * The idempotency key of one call: the hash of (role, prompt version, model, input). The first attempt of a job uses exactly
 * that. A later infrastructure attempt adds its number, and the single quality retry adds the key of the call it retries, so
 * every call of a job has its own key and a repeated call of the same input has the same one.
 */
function callKey<Input, Answer>(ctx: CallContext<Input, Answer>, retryOf: string | undefined): string {
  return contentHash({
    role: ctx.role.role,
    promptVersion: ctx.promptVersion,
    model: ctx.route.model,
    input: ctx.input,
    ...(ctx.attempt > 1 ? { attempt: ctx.attempt } : {}),
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
): Promise<Settled<Answer>> {
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
      try {
        const answer = await structuredChat(ctx.deps.gateway, {
          organizationId: ctx.workspaceId,
          capability: ctx.role.capability,
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
          // The call was billed even though the answer failed its contract. Use OpenRouter's cost when it reported one; otherwise the
          // hold stands, flagged as an estimate.
          return { value: { verdict: "invalid", issues: [...error.issues], usage: error.usage }, actualUsd: error.usage?.costUsd ?? null };
        }
        throw error;
      }
    },
  );

  if (outcome.status === "refused") return { status: "refused", reason: outcome.reason, alerts: outcome.alerts };
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
    actualIsEstimate: entry.actualIsEstimate === true,
    verdict: value.verdict === "answered" ? "answered" : "invalid_answer",
    issues: value.verdict === "invalid" ? [...value.issues] : [],
  };
  return { status: "settled", verdict: value, call, alerts: outcome.alerts };
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

  const route = deps.gateway.route(role.capability);
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
    deps,
    role,
    workspaceId: request.workspaceId,
    reservationId,
    route,
    promptVersion: prompt.id,
    estimateUsd: estimateClaudeUsd(route.model, role.estimateTokens),
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
  const alerts: BudgetAlert[] = [];

  const first = await settle(ctx, base, callKey(ctx, undefined));
  if (first.status === "refused") return { ...head, status: "refused", reason: first.reason, calls, alerts: first.alerts };
  if (first.status === "duplicate") {
    return { ...head, status: "duplicate", entry: first.entry, samePayload: first.samePayload, calls, alerts };
  }
  calls.push(first.call);
  alerts.push(...first.alerts);
  if (first.verdict.verdict === "answered") {
    return { ...head, status: "done", value: first.verdict.answer.value, calls, alerts };
  }

  const retryMessages: ChatMessage[] = [
    ...base,
    { role: "user", content: retryMessage(role.retryRule, first.verdict.issues) },
  ];
  const retry = await settle(ctx, retryMessages, callKey(ctx, first.call.idempotencyKey));
  if (retry.status === "refused") return { ...head, status: "refused", reason: retry.reason, calls, alerts: [...alerts, ...retry.alerts] };
  if (retry.status === "duplicate") {
    return { ...head, status: "duplicate", entry: retry.entry, samePayload: retry.samePayload, calls, alerts };
  }
  calls.push(retry.call);
  alerts.push(...retry.alerts);
  if (retry.verdict.verdict === "answered") {
    return { ...head, status: "done", value: retry.verdict.answer.value, calls, alerts };
  }
  throw new RoleAnswerError(role.role, calls.length, retry.verdict.issues, stage);
}
