/**
 * Writes creative copy from a brief with the text model. Server-only: the creative action's handler loads this module. A brief
 * that production refuses is refused before the model is called, so a held or rejected brief sends nothing to a provider.
 */
import { getSql } from "../../db.ts";
import { renderGenerationPrompt } from "../brief/engine.ts";
import { promptById } from "../prompts/registry.ts";
import { activeChatProvider, extractJson, providerStatus } from "../providers/chat.server.ts";
import { asText, clip, ensurePromptRows, id, requireBrand } from "../machine-shared.ts";
import { assertOpportunityClear } from "../opportunity/actions.ts";
import { productionRefusalFor } from "./brief-status.ts";
import { briefDraftFromRow, produceCreative } from "./creative-actions.ts";

export async function generateCreativeFor(userId: string, data: { brandId: string; briefId: string }) {
  const sql = await getSql();
  const access = await requireBrand(sql, userId, data.brandId, "member");
  const briefs = await sql<Record<string, unknown>>`
    select * from briefs where id = ${data.briefId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId} limit 1
  `;
  const briefRow = briefs[0];
  if (!briefRow) throw new Error("Brief not found.");
  // Refused before any model call. A brief awaiting review or rejected is not sent to a provider, and no model run is recorded.
  const refusal = productionRefusalFor(asText(briefRow.status));
  if (refusal) throw new Error(refusal);
  const opportunityId = asText(briefRow.opportunity_id);
  if (opportunityId) await assertOpportunityClear(sql, opportunityId);
  const prompt = promptById("creative_script");
  if (!prompt) throw new Error("Creative prompt is not active.");
  const provider = activeChatProvider();
  const status = providerStatus();
  if (!provider) return { status: "unavailable" as const, message: "No text model is configured. You can still write the script yourself." };
  const brief = briefDraftFromRow(briefRow);
  const rendered = renderGenerationPrompt(brief);
  const result = await provider.complete({
    model: status.model,
    temperature: prompt.temperature,
    maxTokens: 900,
    system: rendered.system,
    user: rendered.user,
  });
  const correlationId = id();
  await ensurePromptRows(sql);
  await sql`
    insert into model_runs (
      id, organization_id, brand_id, correlation_id, operation, provider, model, prompt_id, prompt_version,
      input_ref, output, latency_ms, tokens, status, error
    ) values (
      ${id()}, ${access.organizationId}, ${data.brandId}, ${correlationId}, 'creative_script',
      ${result.ok ? result.provider : provider.id}, ${status.model}, ${prompt.id}, ${prompt.version},
      ${data.briefId}, ${result.ok ? result.content.slice(0, 8000) : ""}, ${result.ok ? result.latencyMs : 0},
      ${result.ok ? result.tokens : null}, ${result.ok ? "completed" : result.status}, ${result.ok ? "" : result.error}
    )
  `;
  if (!result.ok) return { status: "failed" as const, message: result.error };
  let copy: { hook: string; script: string; offer: string; cta: string; visualTreatment: string; claims: string[] };
  try {
    const parsed = extractJson(result.content) as Record<string, unknown>;
    copy = {
      hook: clip(parsed.hook, 400, "Hook", true),
      script: clip(parsed.script, 4000, "Script", true),
      offer: clip(parsed.offer, 400, "Offer"),
      cta: clip(parsed.cta, 240, "Call to action", true),
      visualTreatment: clip(parsed.visualTreatment, 400, "Visual treatment"),
      claims: Array.isArray(parsed.claims) ? parsed.claims.filter((item) => typeof item === "string").map((item) => item.trim()).slice(0, 8) : [],
    };
  } catch (error) {
    return { status: "failed" as const, message: error instanceof Error ? error.message : "The model output was not usable." };
  }
  const produced = await produceCreative(sql, {
    userId,
    organizationId: access.organizationId,
    brandId: data.brandId,
    briefId: data.briefId,
    ...copy,
    provider: result.provider,
    model: result.model,
    modelResponse: result.content,
    jobStatus: "completed",
  });
  return { status: "completed" as const, ...produced };
}
