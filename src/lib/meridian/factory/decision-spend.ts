/**
 * The spend a Factory decision makes (NORTH_STAR section 8, item 2). Each decision that calls an engine and reports its token usage
 * writes one metered factory_costs row for its run. The row holds the engine, the model and the prompt and completion tokens. Its
 * basis is 'tokens'. Its dollar cost is written only when the price table has an entry for the engine and model; otherwise the cost is
 * null, and the row is tokens only.
 *
 * A decision that called no engine spent nothing and writes no row. An engine that reports no usage (the TypeSafe JEV engine) has no
 * token count to meter, so it writes no row either: its spend is not measured, and the run says so.
 *
 * The row's id is derived from the gate record that holds the decision. A decision is written once, so a repeated record writes nothing.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { DecisionUsage } from "../decisions/types.ts";
import { PRICE_TABLE_VERSION, decisionCostMicros, tokenPriceFor } from "./price-table.ts";

export type DecisionSpendInput = {
  organizationId: string;
  brandId: string;
  runId: string;
  /** The Factory stage the decision was made in, such as factory.grade or factory.produce. */
  stage: string;
  productionJobId?: string | null;
  /** The gate record that holds the decision (decision_gate_records). Null when the record could not be written. */
  gateRecordId: string | null;
  /** Whether the gate called an engine at all. A decision answered from a stored record, or refused locally, did not. */
  engineCalled: boolean;
  engineId: string | null;
  requestedModel: string | null;
  returnedModel: string | null;
  usage: DecisionUsage | undefined;
};

export type DecisionSpendOutcome = "recorded" | "already-recorded" | "not-metered";

/**
 * Writes the metered row for one decision, if it spent tokens. Returns what happened: a new row, a row that was already there for this
 * decision, or nothing to meter. The caller passes the gate result it already has; this makes no engine call.
 */
export async function recordDecisionSpend(sql: Sql, input: DecisionSpendInput): Promise<DecisionSpendOutcome> {
  if (!input.engineCalled || !input.engineId || !input.usage) return "not-metered";
  const promptTokens = typeof input.usage.inputTokens === "number" ? input.usage.inputTokens : null;
  const completionTokens = typeof input.usage.outputTokens === "number" ? input.usage.outputTokens : null;
  if (promptTokens === null && completionTokens === null) return "not-metered";

  // A price needs both counts. Without both, the cost is unknown, and it is stored as null.
  const entry = tokenPriceFor(input.engineId, input.requestedModel, input.returnedModel);
  const micros =
    entry && promptTokens !== null && completionTokens !== null
      ? decisionCostMicros(entry, {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cachedInputTokens: input.usage.cachedInputTokens,
        })
      : null;
  const id = input.gateRecordId ? `spend:${input.gateRecordId}` : `spend:${randomUUID()}`;
  const model = (input.returnedModel ?? "").trim() || (input.requestedModel ?? "").trim();
  const inserted = await sql<{ id: string }>`
    insert into factory_costs (
      id, organization_id, brand_id, run_id, stage, cents, seconds, provider, production_job_id, basis, created_at,
      micros, engine, model, prompt_tokens, completion_tokens, price_version, gate_record_id
    ) values (
      ${id}, ${input.organizationId}, ${input.brandId}, ${input.runId}, ${input.stage}, null, 0, ${input.engineId},
      ${input.productionJobId ?? null}, 'tokens', now(), ${micros}, ${input.engineId}, ${model}, ${promptTokens}, ${completionTokens},
      ${entry ? PRICE_TABLE_VERSION : ""}, ${input.gateRecordId ?? ""}
    )
    on conflict (id) do nothing
    returning id
  `;
  return inserted[0] ? "recorded" : "already-recorded";
}

/**
 * Writes the tokens a perception read reported. There is no published price for a perception model in the price table, so the dollar
 * cost is null and caps do not count it. A read that reported no tokens writes nothing.
 */
export async function recordPerceptionSpend(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    perceptionRunId: string;
    providerId: string;
    model: string;
    usage?: { inputTokens?: number; outputTokens?: number } | null;
  },
): Promise<DecisionSpendOutcome> {
  const promptTokens = typeof input.usage?.inputTokens === "number" ? input.usage.inputTokens : null;
  const completionTokens = typeof input.usage?.outputTokens === "number" ? input.usage.outputTokens : null;
  if (promptTokens === null && completionTokens === null) return "not-metered";
  const id = `spend:perception:${input.perceptionRunId}`;
  const inserted = await sql<{ id: string }>`
    insert into factory_costs (
      id, organization_id, brand_id, run_id, stage, cents, seconds, provider, production_job_id, basis, created_at,
      micros, engine, model, prompt_tokens, completion_tokens, price_version, gate_record_id
    ) values (
      ${id}, ${input.organizationId}, ${input.brandId}, ${null}, 'perception', null, 0, ${input.providerId},
      ${null}, 'tokens', now(), ${null}, ${input.providerId}, ${input.model}, ${promptTokens}, ${completionTokens},
      ${""}, ${""}
    )
    on conflict (id) do nothing
    returning id
  `;
  return inserted[0] ? "recorded" : "already-recorded";
}
