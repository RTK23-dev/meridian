/**
 * Writes creative copy from a brief with the text model. Server-only: the creative action's handler loads this module. A brief
 * that production refuses is refused before the model is called, so a held or rejected brief sends nothing to a provider.
 */
import { getSql } from "../../db.ts";
import { renderGenerationPrompt } from "../brief/engine.ts";
import { promptById } from "../prompts/registry.ts";
import { completeGenerationTask, extractJson } from "../providers/chat.server.ts";
import { recordGenerationRun } from "../providers/model-run.ts";
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
  const brief = briefDraftFromRow(briefRow);
  const rendered = renderGenerationPrompt(brief);
  // The copy task's model is the workspace's own choice, checked against the live catalogue before anything is sent.
  const result = await completeGenerationTask(access.organizationId, "copy", {
    temperature: prompt.temperature,
    maxTokens: 900,
    system: rendered.system,
    user: rendered.user,
  });
  // A refusal before any call (no model, no key, an unchecked model) sends nothing, so nothing is recorded as a run.
  if (!result.ok && result.status === "unavailable") {
    return { status: "unavailable" as const, message: `${result.error} You can still write the script yourself.` };
  }
  await ensurePromptRows(sql);
  await recordGenerationRun(
    sql,
    { organizationId: access.organizationId, brandId: data.brandId, correlationId: id(), operation: "creative_script", promptId: prompt.id, promptVersion: prompt.version, inputRef: data.briefId },
    result,
  );
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
