import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { HypitJobContract } from "./contract.ts";
import type { HypitArtifactRecord, HypitJobRecord, HypitJobState, HypitLedger } from "./handoff.ts";

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readContract(value: unknown): HypitJobContract {
  return JSON.parse(asText(value)) as HypitJobContract;
}

function readArtifact(value: unknown): HypitArtifactRecord | null {
  const text = asText(value);
  if (!text) return null;
  return JSON.parse(text) as HypitArtifactRecord;
}

function fromRow(row: Record<string, unknown>): HypitJobRecord {
  return {
    meridianJobId: asText(row.id),
    organizationId: asText(row.organization_id),
    brandId: asText(row.brand_id),
    provider: "hypit",
    providerJobId: asText(row.provider_job_id),
    status: asText(row.status) as HypitJobState,
    code: asText(row.code),
    error: asText(row.error),
    contract: readContract(row.contract),
    artifact: readArtifact(row.artifact),
  };
}

/** Persists the handoff. Bytes stay in asset storage, not in this row. */
export function sqlHypitLedger(sql: Sql): HypitLedger {
  return {
    async find(organizationId, jevDecisionId, briefId) {
      const rows = await sql<Record<string, unknown>>`
        select id, organization_id, brand_id, provider_job_id, status, code, error, contract, artifact
        from hypit_jobs
        where organization_id = ${organizationId}
          and jev_decision_id = ${jevDecisionId}
          and brief_id = ${briefId}
        limit 1
      `;
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async save(record) {
      const lineage = record.contract.lineage;
      await sql`
        insert into hypit_jobs (
          id, organization_id, brand_id, jev_decision_id, brief_id, provider, provider_job_id,
          status, code, error, contract, artifact
        ) values (
          ${record.meridianJobId}, ${record.organizationId}, ${record.brandId}, ${lineage.jevDecisionId},
          ${lineage.briefId}, ${record.provider}, ${record.providerJobId}, ${record.status}, ${record.code},
          ${record.error}, ${JSON.stringify(record.contract)}, ${record.artifact ? JSON.stringify(record.artifact) : ""}
        )
        on conflict (organization_id, jev_decision_id, brief_id) do update set
          provider_job_id = excluded.provider_job_id,
          status = excluded.status,
          code = excluded.code,
          error = excluded.error,
          contract = excluded.contract,
          artifact = excluded.artifact,
          updated_at = now()
      `;
    },
  };
}

export async function storeHypitArtifact(sql: Sql, job: HypitJobRecord, bytes: Uint8Array): Promise<{ checksum: string; byteSize: number }> {
  if (job.status !== "succeeded" || !job.artifact) {
    throw new Error("Hypit did not return a video. Nothing was stored.");
  }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const body = Buffer.from(bytes).toString("base64");
  await sql`
    insert into asset_blobs (
      storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, version, lifecycle
    ) values (
      ${job.artifact.storageKey}, ${job.organizationId}, ${job.brandId}, ${body}, ${job.artifact.mime},
      ${checksum}, ${bytes.byteLength}, 1, 'stored'
    )
    on conflict (storage_key) do update set
      body = excluded.body,
      checksum = excluded.checksum,
      byte_size = excluded.byte_size,
      version = asset_blobs.version + 1,
      updated_at = now()
  `;
  return { checksum, byteSize: bytes.byteLength };
}
