/**
 * Creative image generation for a signed-in user, server only.
 *
 * The attach action generates an image for a creative with the creative's own workspace production key, stores it, and records
 * the visual check. It lives in this module, not in creative-actions.ts, so that the client build never sees its server
 * imports. The server function loads this module inside its handler, as opportunity-brief.server.ts does.
 */
import { getSql } from "@/lib/db";
import { decideForTenant } from "@/lib/meridian/jev/engine";
import { visualQa } from "@/lib/meridian/jev/questions";
import { loadQuestionPolicy } from "@/lib/meridian/jev/policy";
import { promptById } from "@/lib/meridian/prompts/registry";
import { resolveCredential } from "@/lib/meridian/credentials/resolve";
import { generateNanoBananaImage } from "@/lib/meridian/providers/nano-banana.server";
import { readCreativeImage } from "@/lib/meridian/providers/vision.server";
import { id, requireBrand, loadContext, insertDecision, ensurePromptRows } from "../machine-shared";


/**
 * Generates and stores an image for a creative, for a signed-in user. The role and the tenant are checked here. The image is
 * generated with the creative's own workspace production key, resolved through the shared credential resolver.
 */
export async function attachCreativeImageFor(userId: string, data: { brandId: string; creativeId: string }) {
  const sql = await getSql();
  const access = await requireBrand(sql, userId, data.brandId, "member");
  const creatives = await sql<{ title: string; raw_text: string; hook: string; status: string; brief_id: string | null }>`
    select title, raw_text, hook, status, brief_id from creative_records
    where id = ${data.creativeId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      and origin <> 'competitor'
    limit 1
  `;
  const creative = creatives[0];
  if (!creative) throw new Error("Creative not found.");
  if (creative.status === "rejected") throw new Error("Rejected creatives are not illustrated.");
  const briefRows = creative.brief_id ? await sql<{ decision_id: string }>`
    select decision_id from briefs
    where id = ${creative.brief_id} and organization_id = ${access.organizationId} and brand_id = ${data.brandId}
    limit 1
  ` : [];
  const jevDecisionId = briefRows[0]?.decision_id ?? "";
  const prompt = `Advertising still for ${creative.title}. ${creative.hook}. ${creative.raw_text}`.slice(0, 1800);
  // The image is generated with the creative's workspace key. An unusable or absent key means no request is made.
  const workspaceKey = await resolveCredential(sql, access.organizationId, "production");
  const image = await generateNanoBananaImage({
    prompt,
    promptVersion: "creative-image-v1",
    apiKey: workspaceKey.status === "ready" ? workspaceKey.secret : undefined,
  });
  if (image.status !== "ready") return { status: image.status, message: image.error };
  const assetId = id();
  const storageKey = `${access.organizationId}/${data.brandId}/creative/${data.creativeId}/${assetId}.png`;
  await sql`
    insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, version, lifecycle)
    values (${storageKey}, ${access.organizationId}, ${data.brandId}, ${Buffer.from(image.bytes).toString("base64")}, 'image/png', ${image.sha256}, ${image.bytes.byteLength}, 1, 'stored')
    on conflict (storage_key) do nothing
  `;
  await sql`
    insert into assets (
      id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
      lifecycle, checksum, width, height, byte_size, provider, model, prompt_version, kind, media_status, provenance
    ) values (
      ${assetId}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, 1, ${storageKey}, ${image.sha256},
      'image/png', 'google:nano-banana', 'stored', 'stored', ${image.sha256}, ${image.width}, ${image.height},
      ${image.bytes.byteLength}, ${image.provider}, ${image.model}, ${image.promptVersion}, 'image', 'completed', ${`jev-creative-image:${jevDecisionId || "no-decision"}`}
    )
  `;
  await sql`update creative_records set asset_url = ${storageKey}, updated_at = now() where id = ${data.creativeId} and organization_id = ${access.organizationId} and brand_id = ${data.brandId}`;
  const loaded = await loadContext(sql, access.organizationId, data.brandId);
  const product = loaded.products.find((item) => creative.raw_text.includes(item.name) || creative.title.includes(item.name)) ?? loaded.products[0];
  const reading = await readCreativeImage({
    imageUrl: `data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}`,
    productName: product?.name ?? "",
    allowedClaims: product?.allowedClaims ?? "",
    prohibitedClaims: [loaded.brain.prohibitedClaims, product?.prohibitedClaims ?? ""].filter(Boolean).join("\n"),
  });
  const visualInput = reading.ok
    ? reading.evidence
    : {
        available: false,
        logoPresent: null,
        logoMatchProbability: null,
        paletteMatch: null,
        productMatch: null,
        claimDetected: null,
        claimSupported: null,
        toneFit: null,
      };
  const visualPolicy = await loadQuestionPolicy(sql, access.organizationId, visualQa);
  const visual = decideForTenant(visualPolicy.question, visualInput, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    evidence: loaded.creatives,
  }, {
    policyVersion: visualPolicy.policy.policyVersion,
    calibration: visualPolicy.policy.calibration,
    provider: reading.ok ? reading.provider : "jev",
    model: reading.ok ? reading.model : "visual-qa",
  });
  const decisionId = id();
  const correlationId = id();
  await insertDecision(sql, {
    id: decisionId,
    organizationId: access.organizationId,
    brandId: data.brandId,
    correlationId,
    questionId: visual.questionId,
    questionVersion: visual.questionVersion,
    subjectType: "creative_image",
    subjectId: data.creativeId,
    input: visualInput,
    evidence: visual.evidence,
    probability: visual.probability,
    confidence: visual.confidence,
    thresholds: visual.thresholds,
    decision: visual.decision,
    reasons: visual.reasons,
    provider: reading.ok ? reading.provider : visual.provider,
    model: reading.ok ? reading.model : visual.model,
    modelResponse: reading.ok ? reading.raw : "",
    answer: visual.answer,
    schemaVersion: visual.schemaVersion,
    policyVersion: visual.policyVersion,
    calibrationVersion: visual.calibrationVersion,
  });
  if (reading.ok) {
    const promptAsset = promptById("visual_evidence");
    if (promptAsset) {
      await ensurePromptRows(sql);
      await sql`
        insert into model_runs (
          id, organization_id, brand_id, correlation_id, operation, provider, model, prompt_id, prompt_version,
          input_ref, output, latency_ms, tokens, status, error
        ) values (
          ${id()}, ${access.organizationId}, ${data.brandId}, ${correlationId}, 'visual_evidence',
          ${reading.provider}, ${reading.model}, ${promptAsset.id}, ${promptAsset.version},
          ${data.creativeId}, ${reading.raw}, ${reading.latencyMs}, ${reading.tokens}, 'completed', ''
        )
      `;
    }
  }
  if (visual.decision === "HUMAN_REVIEW") {
    await sql`
      insert into reviews (id, organization_id, brand_id, decision_id, creative_id, subject_label)
      values (${id()}, ${access.organizationId}, ${data.brandId}, ${decisionId}, ${data.creativeId}, ${reading.ok ? "Image needs a person" : "Image has no vision check"})
    `;
  }
  if (visual.decision === "REJECT") {
    await sql`
      insert into rejections (id, organization_id, brand_id, creative_id, decision_id, reason_code, note, rejected_by)
      values (
        ${id()}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, ${decisionId},
        ${"visual_mismatch"}, ${visual.reasons.join(" ").slice(0, 500)}, ${"jev"}
      )
    `;
  }
  const message = reading.ok ? (visual.reasons[0] ?? "Vision evidence was scored.") : reading.error;
  return { status: "stored" as const, decision: visual.decision, message };
}
