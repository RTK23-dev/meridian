import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { Transport } from "../providers/http.ts";
import { uploadMetaVideo } from "../providers/meta.ts";

type StoredVideo = {
  status: "stored"; externalId: string; reused: boolean;
  hypitJobId: string; jevDecisionId: string; briefId: string; storageKey: string; sha256: string; byteLength: number;
};
type VideoFailure = { status: "failed" | "NOT_CONNECTED"; externalId: null; error: string };

/** Validates the complete stored Hypit/JEV chain before uploading, then records Meta's confirmed video id. */
export async function publishHypitVideoToMeta(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    creativeId: string;
    actorId: string;
    name: string;
    accessToken: string;
    adAccountId: string;
    existingVideoId?: string;
    transport: Transport;
    correlationId: string;
  },
): Promise<StoredVideo | VideoFailure | null> {
  const creatives = await sql<Record<string, unknown>>`
    select c.organization_id, c.brand_id, c.status, c.brief_id, c.workflow,
      a.organization_id as asset_organization_id, a.brand_id as asset_brand_id,
      a.storage_key, a.checksum, a.content_hash, a.mime_type, a.byte_size, a.kind, a.provider
    from creative_records c left join assets a on a.creative_id = c.id
    where c.id = ${input.creativeId}
    order by a.version desc limit 1
  `;
  const creative = creatives[0];
  if (!creative) return null;
  let workflow: Record<string, unknown>;
  try { workflow = parseObject(creative.workflow); } catch { return null; }
  if (workflow.provider !== "hypit" || workflow.kind !== "video") return null;
  const reject = (error: string): VideoFailure => ({ status: "failed", externalId: null, error });
  if (asText(creative.organization_id) !== input.organizationId || asText(creative.brand_id) !== input.brandId ||
      (creative.asset_organization_id != null && asText(creative.asset_organization_id) !== input.organizationId) ||
      (creative.asset_brand_id != null && asText(creative.asset_brand_id) !== input.brandId)) {
    return reject("This Hypit artifact belongs to another workspace. Nothing was sent.");
  }
  if (creative.asset_organization_id == null || creative.asset_brand_id == null) {
    return reject("The stored Hypit MP4 is missing. Nothing was sent.");
  }
  if (creative.status !== "approved" || creative.kind !== "video" || creative.provider !== "hypit") {
    return reject("The Hypit video is not approved for publishing. Nothing was sent.");
  }
  const hypitJobId = asText(workflow.hypitJobId);
  const jevDecisionId = asText(workflow.jevDecisionId);
  const briefId = asText(creative.brief_id);
  if (!hypitJobId || !jevDecisionId || !briefId) return reject("The Hypit/JEV lineage is incomplete. Nothing was sent.");
  const jobs = await sql<Record<string, unknown>>`
    select id, provider_job_id, status, artifact, contract, jev_decision_id, brief_id from hypit_jobs
    where provider_job_id = ${hypitJobId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      and brief_id = ${briefId} limit 1
  `;
  const job = jobs[0];
  if (!job || job.status !== "succeeded" || asText(job.jev_decision_id) !== jevDecisionId) {
    return reject("The Hypit job does not match this approved creative. Nothing was sent.");
  }
  let artifact: Record<string, unknown>;
  let contract: Record<string, unknown>;
  try {
    artifact = parseObject(job.artifact);
    contract = parseObject(job.contract);
  } catch {
    return reject("The Hypit artifact lineage is invalid. Nothing was sent.");
  }
  const contractLineage = parseObject(contract.lineage);
  if (asText(contract.organizationId) !== input.organizationId || asText(contract.brandId) !== input.brandId ||
      asText(contractLineage.jevDecisionId) !== jevDecisionId || asText(contractLineage.briefId) !== briefId) {
    return reject("The Hypit/JEV tenant lineage could not be verified. Nothing was sent.");
  }
  const storageKey = asText(creative.storage_key);
  const sha256 = asText(artifact.sha256);
  const mime = asText(artifact.mime);
  const byteLength = Number(artifact.byteLength);
  if (!storageKey || storageKey !== asText(artifact.storageKey) || !sha256 || mime !== "video/mp4" ||
      asText(creative.mime_type) !== "video/mp4" || Number(creative.byte_size) !== byteLength ||
      (asText(creative.checksum) && asText(creative.checksum) !== sha256) ||
      (asText(creative.content_hash) && asText(creative.content_hash) !== sha256)) {
    return reject("The stored Hypit MP4 metadata does not match its verified artifact. Nothing was sent.");
  }
  const decisions = await sql<Record<string, unknown>>`
    select decision, reviewer_decision from jev_decisions
    where id = ${jevDecisionId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId} limit 1
  `;
  const decision = decisions[0];
  if (!decision || !(decision.decision === "AUTO_APPROVE" ||
      (decision.decision === "HUMAN_REVIEW" && decision.reviewer_decision === "approved"))) {
    return reject("JEV has not approved this creative. Nothing was sent.");
  }
  const blobs = await sql<Record<string, unknown>>`
    select body, mime_type, checksum, byte_size from asset_blobs
    where storage_key = ${storageKey} and organization_id = ${input.organizationId} and brand_id = ${input.brandId} limit 1
  `;
  const blob = blobs[0];
  if (!blob || asText(blob.mime_type) !== "video/mp4") return reject("The tenant-scoped Hypit MP4 is missing. Nothing was sent.");
  const bytes = new Uint8Array(Buffer.from(asText(blob.body), "base64"));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== byteLength || Number(blob.byte_size) !== byteLength || asText(blob.checksum) !== sha256 ||
      hash !== sha256 || !hasMp4Signature(bytes)) {
    return reject("The stored Hypit MP4 bytes failed integrity verification. Nothing was sent.");
  }
  if (!input.accessToken.trim() || !input.adAccountId.trim().startsWith("act_")) {
    return { status: "NOT_CONNECTED", externalId: null, error: "Meta video publishing is not connected. Configure an access token and ad account." };
  }
  const lineage = { hypitJobId, jevDecisionId, briefId, storageKey, sha256, byteLength };
  if (input.existingVideoId?.trim()) return { status: "stored", externalId: input.existingVideoId, reused: true, ...lineage };
  const uploaded = await uploadMetaVideo(
    { accessToken: input.accessToken, adAccountId: input.adAccountId },
    { adAccountId: input.adAccountId, bytes, name: input.name },
    input.transport,
  );
  if (uploaded.status !== "stored") return uploaded;
  const idempotencyKey = `${input.brandId}:${input.creativeId}:video`;
  await sql`
    insert into provider_objects (
      id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status, last_error, synced_at
    ) values (
      ${crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, 'meta', 'video', ${idempotencyKey},
      ${uploaded.externalId}, 'stored', '', now()
    )
    on conflict (organization_id, provider, object_type, idempotency_key) do update set synced_at = now()
    where provider_objects.external_id = excluded.external_id
  `;
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.actorId}, 'publishing.confirmed',
      'video', ${uploaded.externalId}, ${JSON.stringify({ hypitJobId, jevDecisionId, briefId, storageKey, sha256, byteLength, correlationId: input.correlationId })}
    )
  `;
  return { status: "stored", externalId: uploaded.externalId, reused: false, ...lineage };
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
function asText(value: unknown): string { return typeof value === "string" ? value : value == null ? "" : String(value); }
function hasMp4Signature(bytes: Uint8Array): boolean { return bytes.byteLength >= 16 && Buffer.from(bytes.subarray(0, 32)).toString("latin1").includes("ftyp"); }
