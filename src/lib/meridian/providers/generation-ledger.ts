// The budget ledger for ordinary text generation. Every paid call is a row in model_runs, and the row is its own budget hold:
//
//   1. bound: the worst case the call can cost, from the chosen model's stated prices, its context length and max_tokens. A call
//      that cannot be bounded (an image with no stated context length, a missing price) is refused before anything is written.
//   2. reserve: a row with status 'in_flight' and estimate_usd = that bound. Under a per-workspace transaction lock, the call is
//      refused when the month's held spend plus this bound would exceed the workspace's monthly budget (when one is set).
//   3. settle: the outcome is written once, on a row that is still 'in_flight':
//        completed   the provider answered and reported its cost (cost_usd; null when it reported none)
//        failed      the call was never sent (the gateway reported the provider not connected, before any transport); nothing was sent
//        uncertain   the outcome may have been billed: a timeout, any error status, or an unreadable reply. The hold stays and is never
//                    retried. OpenRouter's documentation states no billing rule for its error statuses, so no status releases a hold.
//   An administrator may release an uncertain hold after checking the provider's account (releaseUncertainHold). The release is audited
//   in generation_hold_releases and applies once.
//   Held spend (completed, in_flight and uncertain rows) counts against the month at the reported cost, or at the estimate when no
//   cost was reported. The estimate is never recorded as a cost. A released hold is not held spend.

import { randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import { monthlyVideoBudgetUsd } from "../settings/video-budget.ts";
import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";

/** The per-call ceiling, in USD, that an ordinary text call may not exceed. */
export const GENERATION_CEILING_ENV = "OPENROUTER_GENERATION_MAX_USD_PER_CALL";
export const DEFAULT_GENERATION_CEILING_USD = 0.05;

/**
 * What every uncertain hold says about itself. The hold stays until an administrator releases it, so the workspace's budget shows the
 * money at risk rather than hiding it.
 */
export const UNCERTAIN_OUTCOME_NOTE =
  "Whether it was billed is not known, so the hold stays on the ledger until an administrator releases it. It was not retried.";

/** Bytes of request framing (role names, the JSON envelope) added to the bound. Generous: the bound must not undercount. */
const REQUEST_OVERHEAD_BYTES = 256;

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type CallBound = { ok: true; usd: number; inputTokensBound: number; outputTokensBound: number } | { ok: false; reason: string };

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The worst case one call can cost, in USD. Input is bounded by the request's UTF-8 byte count (a tokenizer produces at most one
 * token per byte), capped at the context length when it is stated. A call with an image uses the whole context, because the listing
 * does not state an image's tokens. Output is bounded by max_tokens at the completion price.
 */
export function boundGenerationCall(input: {
  choice: Pick<TextModelChoice, "promptUsdPerToken" | "completionUsdPerToken" | "contextLength">;
  system: string;
  user: string | ContentPart[];
  maxTokens: number;
}): CallBound {
  const { promptUsdPerToken, completionUsdPerToken, contextLength } = input.choice;
  if (!Number.isFinite(promptUsdPerToken) || !Number.isFinite(completionUsdPerToken)) {
    return { ok: false, reason: "The model's prices are not stated, so the call's cost cannot be bounded. Nothing was sent." };
  }
  if (!Number.isInteger(input.maxTokens) || input.maxTokens <= 0) {
    return { ok: false, reason: "The output limit must be a positive whole number of tokens, so the call's cost cannot be bounded. Nothing was sent." };
  }
  const parts: ContentPart[] = typeof input.user === "string" ? [{ type: "text", text: input.user }] : input.user;
  const hasImage = parts.some((part) => part.type === "image_url");
  let inputTokens: number;
  if (hasImage) {
    if (contextLength === null) {
      return {
        ok: false,
        reason: "The model's context length is not stated in the live catalogue, so an image's cost cannot be bounded. Nothing was sent.",
      };
    }
    inputTokens = contextLength;
  } else {
    const textBytes = utf8Bytes(input.system) + parts.reduce((sum, part) => sum + (part.type === "text" ? utf8Bytes(part.text) : 0), 0);
    inputTokens = Math.min(textBytes + REQUEST_OVERHEAD_BYTES, contextLength ?? Number.POSITIVE_INFINITY);
  }
  const usd = inputTokens * promptUsdPerToken + input.maxTokens * completionUsdPerToken;
  if (!Number.isFinite(usd) || usd < 0) return { ok: false, reason: "The call's cost could not be bounded. Nothing was sent." };
  return { ok: true, usd, inputTokensBound: inputTokens, outputTokensBound: input.maxTokens };
}

export type CeilingRead = { ok: true; usd: number } | { ok: false; reason: string };

/** The per-call ceiling from the environment. Blank means the default. A value that is not a positive number refuses every call. */
export function generationCeilingUsd(env: Record<string, string | undefined> = process.env): CeilingRead {
  const raw = env.OPENROUTER_GENERATION_MAX_USD_PER_CALL?.trim() ?? "";
  if (raw === "") return { ok: true, usd: DEFAULT_GENERATION_CEILING_USD };
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, reason: `${GENERATION_CEILING_ENV} must be a positive number of dollars. Nothing was sent.` };
  }
  return { ok: true, usd: value };
}

export type HoldInput = {
  organizationId: string;
  brandId: string | null;
  correlationId: string;
  operation: string;
  promptId: string;
  promptVersion: string;
  inputRef: string;
  provider: string;
  model: string;
  modelSource: string;
};

export type HoldResult = { status: "held"; id: string } | { status: "refused"; reason: string };

/**
 * The spend the workspace holds in the current month: reported cost where there is one, the estimate where there is not. Failed rows
 * (refused before generating) hold nothing.
 */
export async function monthlyHeldUsd(sql: Sql, organizationId: string): Promise<number> {
  const rows = await sql<{ held: string | number | null }>`
    select coalesce(sum(coalesce(cost_usd, estimate_usd)), 0) as held from model_runs
    where organization_id = ${organizationId}
      and status in ('completed', 'in_flight', 'uncertain')
      and created_at >= date_trunc('month', now())
  `;
  return Number(rows[0]?.held ?? 0);
}

/**
 * Writes the hold for one call, or refuses it. The workspace's transaction lock makes the month check and the write one step, so two
 * calls cannot both pass a budget that only one of them fits. A workspace without a monthly budget has no monthly limit; the per-call
 * ceiling still applies to every call.
 */
export async function reserveGenerationCall(sql: Sql, input: HoldInput, estimateUsd: number): Promise<HoldResult> {
  if (!input.organizationId.trim()) return { status: "refused", reason: "No workspace is in scope, so no budget can be held. Nothing was sent." };
  const id = randomUUID();
  return withTransaction(sql, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`generation-ledger:${input.organizationId}`}))`;
    const cap = await monthlyVideoBudgetUsd(tx, input.organizationId);
    if (cap !== null) {
      const held = await monthlyHeldUsd(tx, input.organizationId);
      if (held + estimateUsd > cap + 1e-9) {
        return {
          status: "refused" as const,
          reason: `This call could cost up to $${estimateUsd.toFixed(6)}, and the month's held spend is $${held.toFixed(6)} of a $${cap.toFixed(2)} monthly budget. Nothing was sent.`,
        };
      }
    }
    await tx`
      insert into model_runs (
        id, organization_id, brand_id, correlation_id, operation, provider, model, model_source,
        prompt_id, prompt_version, input_ref, output, latency_ms, status, error, estimate_usd
      ) values (
        ${id}, ${input.organizationId}, ${input.brandId}, ${input.correlationId}, ${input.operation}, ${input.provider}, ${input.model},
        ${input.modelSource}, ${input.promptId}, ${input.promptVersion}, ${input.inputRef}, '', 0, 'in_flight', '', ${estimateUsd}
      )
    `;
    return { status: "held" as const, id };
  });
}

export type Settlement =
  | {
      status: "completed";
      output: string;
      latencyMs: number;
      tokens: number | null;
      returnedModel: string | null;
      generationId: string | null;
      costUsd: number | null;
      error: string;
    }
  | { status: "failed"; error: string; latencyMs: number }
  | { status: "uncertain"; error: string; latencyMs: number };

/**
 * Writes the outcome of a held call, once. The update only applies to a row that is still in flight, so a settled hold is never
 * released or settled a second time. A failed write is reported to the caller, which keeps the hold and says so.
 */
export async function settleGenerationCall(sql: Sql, holdId: string, settlement: Settlement): Promise<boolean> {
  const error = settlement.error.slice(0, 500);
  const rows = await sql<{ id: string }>`
    update model_runs set
      status = ${settlement.status},
      output = ${settlement.status === "completed" ? settlement.output.slice(0, 8000) : ""},
      latency_ms = ${settlement.latencyMs},
      tokens = ${settlement.status === "completed" ? settlement.tokens : null},
      returned_model = ${settlement.status === "completed" ? (settlement.returnedModel ?? "") : ""},
      generation_id = ${settlement.status === "completed" ? (settlement.generationId ?? "") : ""},
      cost_usd = ${settlement.status === "completed" ? settlement.costUsd : null},
      error = ${error}
    where id = ${holdId} and status = 'in_flight'
    returning id
  `;
  return rows.length === 1;
}

export type HoldRelease = { status: "released"; holdId: string } | { status: "refused"; reason: string };

/** The shortest reason an administrator may give, so the audit records a reason rather than a click. */
const MIN_RELEASE_REASON = 10;

/**
 * Releases one uncertain hold after an administrator has checked the provider's account for that call. The release is written in the
 * same transaction as the model run's status change, with who released it, when and why. It applies once: the update only matches a
 * row that is still uncertain in this workspace, so a second release, or a release of a completed or in-flight hold, changes nothing.
 * Nothing in the system calls this on its own: it is reached only from an administrator's action.
 */
export async function releaseUncertainHold(
  sql: Sql,
  input: { organizationId: string; holdId: string; actorId: string; reason: string },
): Promise<HoldRelease> {
  const reason = input.reason.trim();
  if (reason.length < MIN_RELEASE_REASON) {
    return { status: "refused", reason: `A release needs a reason of at least ${MIN_RELEASE_REASON} characters, so the audit says why. Nothing was released.` };
  }
  return withTransaction(sql, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`generation-ledger:${input.organizationId}`}))`;
    const rows = await tx<{ id: string }>`
      update model_runs set status = 'released', error = left(error || ${` Released by an administrator: ${reason}`}, 1000)
      where id = ${input.holdId} and organization_id = ${input.organizationId} and status = 'uncertain'
      returning id
    `;
    if (rows.length !== 1) {
      return { status: "refused" as const, reason: "That hold is not an uncertain hold in this workspace, so nothing was released." };
    }
    await tx`
      insert into generation_hold_releases (id, organization_id, model_run_id, actor_id, reason)
      values (${randomUUID()}, ${input.organizationId}, ${input.holdId}, ${input.actorId}, ${reason})
    `;
    return { status: "released" as const, holdId: input.holdId };
  });
}

export type UncertainHold = {
  id: string;
  operation: string;
  model: string;
  estimateUsd: number;
  createdAt: string;
  error: string;
};

/** The uncertain holds of one workspace, oldest first, for an administrator to check against the provider's account. */
export async function uncertainHolds(sql: Sql, organizationId: string): Promise<UncertainHold[]> {
  const rows = await sql<{ id: string; operation: string; model: string; estimate_usd: string | number | null; created_at: string; error: string }>`
    select id, operation, model, estimate_usd, created_at, error from model_runs
    where organization_id = ${organizationId} and status = 'uncertain'
    order by created_at asc
    limit 200
  `;
  return rows.map((row) => ({
    id: row.id,
    operation: row.operation,
    model: row.model,
    estimateUsd: Number(row.estimate_usd ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    error: row.error,
  }));
}
