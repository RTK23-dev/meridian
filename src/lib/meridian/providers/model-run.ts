// One model_runs row per generation call that was sent. A call refused before it was sent (no model, no key, a model the catalogue
// does not check) is not recorded here: the caller returns its reason, and nothing was billed. The row keeps what was asked for and what
// OpenRouter reported back, so a stored output names the model that actually answered it.

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { GenerationResult } from "./chat.server.ts";

export type ModelRunBase = {
  organizationId: string;
  brandId: string | null;
  correlationId: string;
  operation: string;
  promptId: string;
  promptVersion: string;
  inputRef: string;
};

/** Writes the row for one attempt that was sent. A failed attempt is recorded with its reason and no cost. */
export async function recordGenerationRun(sql: Sql, base: ModelRunBase, result: GenerationResult): Promise<void> {
  const fields = result.ok
    ? {
        status: "completed",
        error: "",
        output: result.content.slice(0, 8000),
        latencyMs: result.latencyMs,
        tokens: result.tokens,
        modelSource: result.modelSource,
        returnedModel: result.returnedModel ?? "",
        generationId: result.generationId ?? "",
        costUsd: result.costUsd,
      }
    : {
        status: result.status,
        error: result.error.slice(0, 500),
        output: "",
        latencyMs: 0,
        tokens: null,
        modelSource: "",
        returnedModel: "",
        generationId: "",
        costUsd: null,
      };
  await sql`
    insert into model_runs (
      id, organization_id, brand_id, correlation_id, operation, provider, model, model_source, returned_model, generation_id,
      prompt_id, prompt_version, input_ref, output, latency_ms, tokens, cost_usd, status, error
    ) values (
      ${randomUUID()}, ${base.organizationId}, ${base.brandId}, ${base.correlationId}, ${base.operation}, ${result.provider}, ${result.model ?? ""},
      ${fields.modelSource}, ${fields.returnedModel}, ${fields.generationId}, ${base.promptId}, ${base.promptVersion}, ${base.inputRef},
      ${fields.output}, ${fields.latencyMs}, ${fields.tokens}, ${fields.costUsd}, ${fields.status}, ${fields.error}
    )
  `;
}
