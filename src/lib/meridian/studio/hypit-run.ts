import type { Sql } from "../learning/store.ts";
import { handoffToHypit } from "../hypit/handoff.ts";
import { sqlHypitLedger, storeHypitArtifact } from "../hypit/store.ts";
import type { HypitDecisionSnapshot, HypitHandoffInput } from "../hypit/contract.ts";
import { liveTransport, type Transport } from "../providers/http.ts";
import { publishStoredHypitAsset, sqlPublishLedger } from "../publishing/hypit-asset.ts";
import { normalizeReviewerDecision } from "../jev/reviewer-decision.ts";

export async function generateHypitStudioVideo(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    runId: string;
    actorId: string;
    productName: string;
    opportunityId: string;
    brief: {
      id: string;
      title: string;
      angle: string;
      hook: string;
      message: string;
      cta: string;
      format: string;
      proofType: string;
      constraints: string;
    };
    decision: HypitDecisionSnapshot;
    tone: string;
  },
  options: { env?: { baseUrl?: string; token?: string }; transport?: Transport } = {},
): Promise<{ creativeId: string; storageKey: string }> {
  const handoff: HypitHandoffInput = {
    organizationId: input.organizationId,
    brandId: input.brandId,
    product: input.productName,
    objective: input.brief.message || input.brief.hook,
    angle: input.brief.angle,
    visualDirection: input.brief.constraints || input.brief.hook,
    tone: input.tone || "quiet",
    cta: input.brief.cta,
    format: input.brief.format || "short_ugc",
    aspectRatio: "9:16",
    durationSeconds: 2,
    requiredClaims: [],
    prohibitedClaims: [],
    brandAssets: [],
    briefId: input.brief.id,
    decision: input.decision,
  };
  const result = await handoffToHypit(handoff, {
    env: options.env,
    transport: options.transport ?? liveTransport(),
    ledger: sqlHypitLedger(sql),
  });
  if (!result.ok || !result.job.artifact || !result.artifactBytes) {
    const code = result.job.code || "HYPIT_FAILED";
    throw new Error(`${code}. ${result.job.error || "Hypit did not return a video. Nothing was stored."}`);
  }
  const stored = await storeHypitArtifact(sql, result.job, result.artifactBytes);
  const creativeId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const artifact = result.job.artifact;
  const copy = `${input.productName}. ${input.brief.hook}`;
  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
      message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
    ) values (
      ${creativeId}, ${input.organizationId}, ${input.brandId}, 'generated', ${`${input.brief.title} video`},
      ${copy}, ${input.productName}, ${input.brief.hook}, ${"problem"}, ${input.brief.angle},
      ${copy}, ${input.brief.cta}, ${input.brief.format}, ${input.brief.proofType},
      ${input.opportunityId || null}, ${input.brief.id}, 'in_review', ${input.actorId},
      ${JSON.stringify({
        generationRunId: input.runId,
        provider: "hypit",
        hypitJobId: result.job.providerJobId,
        jevDecisionId: input.decision.id,
        kind: "video",
      })}
    )
  `;
  await sql`
    insert into assets (
      id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
      lifecycle, checksum, width, height, byte_size, duration_ms, provider, model, prompt_version, generation_run_id,
      kind, qa_decision, review_status, media_status, variant_index, provenance
    ) values (
      ${assetId}, ${input.organizationId}, ${input.brandId}, ${creativeId}, 1, ${artifact.storageKey}, ${stored.checksum},
      ${artifact.mime}, 'hypit', 'stored', 'qa_required', ${stored.checksum}, ${artifact.width}, ${artifact.height},
      ${stored.byteSize}, ${artifact.durationMs}, 'hypit', 'hyperframes', 'hypit', ${input.runId},
      'video', '', 'in_review', 'completed', 0, 'hypit'
    )
  `;
  return { creativeId, storageKey: artifact.storageKey };
}

/** Publishes one stored Hypit video through the existing test publisher. A failed job never publishes. */
export async function publishStudioHypitVideo(
  sql: Sql,
  input: { organizationId: string; brandId: string; creativeId: string; actorId: string },
): Promise<{ externalId: string }> {
  const creatives = await sql<{ brief_id: string }>`
    select brief_id from creative_records
    where id = ${input.creativeId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  const briefId = creatives[0]?.brief_id ?? "";
  if (!briefId) throw new Error("The Hypit artifact is missing. Nothing was published.");
  const jobs = await sql<Record<string, unknown>>`
    select id, status, artifact, jev_decision_id from hypit_jobs
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and brief_id = ${briefId}
    limit 1
  `;
  const job = jobs[0];
  if (!job || String(job.status) !== "succeeded") throw new Error("Hypit did not succeed. Nothing was published.");
  const artifact = JSON.parse(typeof job.artifact === "string" && job.artifact ? job.artifact : "{}") as {
    storageKey?: string;
    sha256?: string;
    mime?: string;
    byteLength?: number;
  };
  if (!artifact.storageKey || !artifact.sha256) throw new Error("The Hypit artifact is missing. Nothing was published.");
  const decisions = await sql<{ decision: string; reviewer_decision: string }>`
    select decision, reviewer_decision from jev_decisions
    where id = ${String(job.jev_decision_id)} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  const decision = decisions[0];
  if (!decision) throw new Error("JEV has not approved this creative. Nothing was published.");
  const reviewerDecision = normalizeReviewerDecision(decision.reviewer_decision);
  const approved = decision.decision === "AUTO_APPROVE" || (decision.decision === "HUMAN_REVIEW" && reviewerDecision === "approved");
  if (!approved) throw new Error("JEV has not approved this creative. Nothing was published.");
  const blobs = await sql<{ body: string }>`
    select body from asset_blobs
    where storage_key = ${artifact.storageKey} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  if (!blobs[0]?.body) throw new Error("The Hypit artifact is missing. Nothing was published.");
  const bytes = new Uint8Array(Buffer.from(blobs[0].body, "base64"));
  const published = await publishStoredHypitAsset(
    {
      organizationId: input.organizationId,
      brandId: input.brandId,
      jevDecisionId: String(job.jev_decision_id),
      briefId,
      hypitJobId: String(job.id),
      hypitStatus: "succeeded",
      decision: decision.decision as "AUTO_APPROVE" | "HUMAN_REVIEW",
      reviewerDecision,
      decisionOrganizationId: input.organizationId,
      decisionBrandId: input.brandId,
      storageKey: artifact.storageKey,
      sha256: artifact.sha256,
      mime: artifact.mime || "video/mp4",
      byteLength: bytes.byteLength,
      bytes,
    },
    sqlPublishLedger(sql, input.actorId),
  );
  if (!published.published) throw new Error(published.reason);
  await sql`
    update assets set lifecycle = 'published', review_status = 'published'
    where creative_id = ${input.creativeId} and organization_id = ${input.organizationId}
  `;
  await sql`update creative_records set status = 'testing', updated_at = now() where id = ${input.creativeId}`;
  return { externalId: published.receipt.externalId };
}
