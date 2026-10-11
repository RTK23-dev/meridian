/**
 * Creative image generation for a signed-in user, server only.
 *
 * The attach action generates an image for a creative with the creative's own workspace production key, stores it, and judges
 * it with the same quality judgment durable production uses (image-qc.server.ts). The judgment reads the image bytes through the
 * configured perception provider when the engine cannot see images, and asks the engine gate the semantic questions. The action
 * records the gate's outcome: a review when a person must look, and a rejection when a check fails. It lives in this module, not
 * in creative-actions.ts, so that the client build never sees its server imports. The server function loads this module inside
 * its handler, as opportunity-brief.server.ts does.
 */
import { getSql } from "@/lib/db";
import { semanticNearest } from "@/lib/meridian/embeddings/store";
import { resolveCredential } from "@/lib/meridian/credentials/resolve";
import { generateNanoBananaImage } from "@/lib/meridian/providers/nano-banana.server";
import type { ProductFact } from "../domain.ts";
import { id, requireBrand, loadContext } from "../machine-shared";
import { competitorCopy, factsFor, generatedImageVisual, qcBrandOf, visualFacts, writeJudgment } from "./image-qc.server.ts";

export type CreativeProductMatch = {
  product: ProductFact | null;
  /**
   * stored: the creative's stored product name resolved to one product.
   * copy: no stored name, and the copy or title named exactly one product.
   * none: no stored name, and the copy and title name no product. No product is claimed.
   * unknown: the creative names a product that does not resolve to exactly one. Its product-specific claims cannot be checked.
   */
  evidence: "stored" | "copy" | "none" | "unknown";
};

/**
 * The product a creative is judged against. A stored product name decides when there is one, and a name that matches no product
 * resolves to nothing. No other product is used in its place. With no stored name, the copy or the title must name exactly one
 * product. A product the creative does not name is never claimed.
 */
export function productForCreative(
  products: ProductFact[],
  creative: { product_name: string; raw_text: string; title: string },
): CreativeProductMatch {
  const stored = creative.product_name.trim();
  if (stored) {
    const match = products.find((item) => item.name.trim() === stored);
    return match ? { product: match, evidence: "stored" } : { product: null, evidence: "unknown" };
  }
  const named = products.filter((item) => {
    const name = item.name.trim();
    return name !== "" && (creative.raw_text.includes(name) || creative.title.includes(name));
  });
  const [only] = named;
  if (named.length === 1 && only) return { product: only, evidence: "copy" };
  if (named.length > 1) return { product: null, evidence: "unknown" };
  return { product: null, evidence: "none" };
}

/**
 * Generates and stores an image for a creative, for a signed-in user. The role and the tenant are checked here. The image is
 * generated with the creative's own workspace production key, resolved through the shared credential resolver.
 */
export async function attachCreativeImageFor(userId: string, data: { brandId: string; creativeId: string }) {
  const sql = await getSql();
  const access = await requireBrand(sql, userId, data.brandId, "member");
  const creatives = await sql<{ title: string; raw_text: string; hook: string; angle: string; product_name: string; status: string; brief_id: string | null }>`
    select title, raw_text, hook, angle, product_name, status, brief_id from creative_records
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

  // The judgment compares against the brand as it is now, and reads the creative's persisted copy, not the prompt.
  const loaded = await loadContext(sql, access.organizationId, data.brandId);
  const brand = qcBrandOf(loaded);
  // The product the creative is for: its stored product, or the one its copy names. A product it does not mention is not claimed.
  const product = productForCreative(loaded.products, creative).product;
  const copy = creative.raw_text;
  const visual = await visualFacts(sql, access.organizationId, data.brandId, image.bytes);
  const facts = factsFor(brand, {
    kind: "image",
    productName: creative.product_name || product?.name || "",
    angle: creative.angle,
    copy,
    prompt,
    mime: "image/png",
    byteSize: image.bytes.byteLength,
    width: image.width,
    height: image.height,
    checksum: image.sha256,
    durationMs: null,
    transcript: "",
    sceneCount: 0,
    logoSimilarity: visual.measuredLogo.similarity,
    logoOutcome: visual.measuredLogo.outcome,
    logoEvidence: visual.measuredLogo.evidence,
    paletteDistance: visual.measuredPalette.distance,
    paletteOutcome: visual.measuredPalette.outcome,
    paletteEvidence: visual.measuredPalette.evidence,
    semanticSimilarity: await semanticNearest(copy, competitorCopy(brand)).catch(() => null),
    ownSemanticSimilarity: await semanticNearest(copy, brand.creatives.filter((item) => item.origin !== "competitor").map((item) => item.text)).catch(() => null),
  });
  // The product's own prohibited claims apply to its copy, as they did when the image was first read.
  facts.prohibited = [facts.prohibited, product?.prohibitedClaims ?? ""].filter(Boolean).join("\n");
  const judgment = await writeJudgment(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    creativeId: data.creativeId,
    facts,
    visual: generatedImageVisual(image.bytes, image.sha256),
  });
  if (judgment.rollup === "HUMAN_REVIEW") {
    await sql`
      insert into reviews (id, organization_id, brand_id, decision_id, creative_id, subject_label)
      values (${id()}, ${access.organizationId}, ${data.brandId}, ${judgment.decisionId}, ${data.creativeId}, ${"Image needs a person"})
    `;
  }
  if (judgment.rollup === "REJECT") {
    await sql`
      insert into rejections (id, organization_id, brand_id, creative_id, decision_id, reason_code, note, rejected_by)
      values (
        ${id()}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, ${judgment.decisionId},
        ${"other"}, ${judgment.reason.slice(0, 500)}, ${"creative_qa"}
      )
    `;
  }
  return { status: "stored" as const, decision: judgment.rollup, message: judgment.reason };
}
