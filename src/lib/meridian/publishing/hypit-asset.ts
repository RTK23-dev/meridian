import { createHash } from "node:crypto";
import { assertSameTenant } from "../domain.ts";
import type { Sql } from "../learning/store.ts";
import { publishThrough } from "../providers/boundaries.ts";
import type { TestPublishReceipt } from "../providers/test-provider.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";

export type HypitPublishReceipt = {
  organizationId: string;
  brandId: string;
  jevDecisionId: string;
  briefId: string;
  hypitJobId: string;
  storageKey: string;
  sha256: string;
  byteLength: number;
  mime: string;
  provider: "test";
  externalId: string;
  status: "TEST_PUBLISHED";
  idempotencyKey: string;
};

export type StoredHypitPublishInput = {
  organizationId: string;
  brandId: string;
  jevDecisionId: string;
  briefId: string;
  hypitJobId: string;
  hypitStatus: string;
  decision: "AUTO_APPROVE" | "HUMAN_REVIEW" | "REJECT";
  reviewerDecision: "approved" | "rejected" | "";
  decisionOrganizationId: string;
  decisionBrandId: string;
  storageKey: string;
  sha256: string;
  mime: string;
  byteLength: number;
  bytes: Uint8Array | null;
};

export type HypitPublishLedger = {
  find(organizationId: string, idempotencyKey: string): Promise<HypitPublishReceipt | null>;
  save(receipt: HypitPublishReceipt): Promise<void>;
};

export function memoryPublishLedger(): HypitPublishLedger {
  const rows = new Map<string, HypitPublishReceipt>();
  return {
    async find(organizationId, idempotencyKey) {
      return rows.get(`${organizationId}\0${idempotencyKey}`) ?? null;
    },
    async save(receipt) {
      rows.set(`${receipt.organizationId}\0${receipt.idempotencyKey}`, receipt);
    },
  };
}

function approved(input: StoredHypitPublishInput): boolean {
  if (input.decision === "AUTO_APPROVE") return true;
  return input.decision === "HUMAN_REVIEW" && input.reviewerDecision === "approved";
}

function videoBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16) return false;
  return Buffer.from(bytes.subarray(0, 32)).toString("latin1").includes("ftyp");
}

/**
 * Sends one stored Hypit MP4 through the existing test publisher.
 * A missing file, a failed Hypit job, or an unapproved decision never reaches it.
 */
export async function publishStoredHypitAsset(
  input: StoredHypitPublishInput,
  ledger: HypitPublishLedger,
  dispatch: typeof publishThrough = publishThrough,
): Promise<{ published: false; reason: string } | { published: true; receipt: HypitPublishReceipt }> {
  assertSameTenant(
    [{ organizationId: input.decisionOrganizationId, brandId: input.decisionBrandId }],
    input.organizationId,
    input.brandId,
  );
  const idempotencyKey = input.hypitJobId.trim();
  if (!idempotencyKey) return { published: false, reason: "The Hypit job id is missing. Nothing was published." };
  const existing = await ledger.find(input.organizationId, idempotencyKey);
  if (existing) return { published: true, receipt: existing };
  if (!approved(input)) return { published: false, reason: "JEV has not approved this creative. Nothing was published." };
  if (input.hypitStatus !== "succeeded") return { published: false, reason: "Hypit did not succeed. Nothing was published." };
  if (!input.bytes || input.bytes.byteLength === 0) return { published: false, reason: "The Hypit artifact is missing. Nothing was published." };
  if (input.bytes.byteLength !== input.byteLength || !videoBytes(input.bytes)) {
    return { published: false, reason: "The stored file is not the Hypit MP4. Nothing was published." };
  }
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  if (sha256 !== input.sha256 || !input.mime.startsWith("video/")) {
    return { published: false, reason: "The stored checksum does not match the Hypit artifact. Nothing was published." };
  }
  const outcome = dispatch({
    provider: "test",
    creativeId: input.storageKey,
    allowTestProvider: isTestingRuntimeNow(),
    artifact: { bytes: input.bytes, mime: input.mime, sha256 },
  });
  if (!outcome.externalId || outcome.status !== "TEST_PUBLISHED" || !outcome.receipt) {
    return { published: false, reason: "The test publisher did not accept the artifact. Nothing was stored." };
  }
  const receipt = toReceipt(input, outcome.externalId, outcome.receipt);
  await ledger.save(receipt);
  return { published: true, receipt };
}

function toReceipt(input: StoredHypitPublishInput, externalId: string, proof: TestPublishReceipt): HypitPublishReceipt {
  return {
    organizationId: input.organizationId,
    brandId: input.brandId,
    jevDecisionId: input.jevDecisionId,
    briefId: input.briefId,
    hypitJobId: input.hypitJobId,
    storageKey: input.storageKey,
    sha256: proof.sha256,
    byteLength: proof.byteLength,
    mime: proof.mime,
    provider: "test",
    externalId,
    status: "TEST_PUBLISHED",
    idempotencyKey: input.hypitJobId,
  };
}

/** Writes the existing provider receipt and an audit row. Does not invent a live ad id. */
export function sqlPublishLedger(sql: Sql, actorId: string): HypitPublishLedger {
  return {
    async find(organizationId, idempotencyKey) {
      const rows = await sql<Record<string, unknown>>`
        select external_id, status from provider_objects
        where organization_id = ${organizationId} and provider = 'test' and object_type = 'ad'
          and idempotency_key = ${idempotencyKey}
        limit 1
      `;
      const row = rows[0];
      if (!row) return null;
      const audit = await sql<Record<string, unknown>>`
        select metadata from audit_log
        where organization_id = ${organizationId} and action = 'publishing.confirmed' and object_id = ${String(row.external_id)}
        limit 1
      `;
      const metadata = JSON.parse(typeof audit[0]?.metadata === "string" ? audit[0].metadata : "{}") as Partial<HypitPublishReceipt>;
      if (!metadata.hypitJobId || !metadata.sha256) return null;
      return { ...metadata, externalId: String(row.external_id), status: "TEST_PUBLISHED", provider: "test" } as HypitPublishReceipt;
    },
    async save(receipt) {
      await sql`
        insert into provider_objects (
          id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status
        ) values (
          ${crypto.randomUUID()}, ${receipt.organizationId}, ${receipt.brandId}, 'test', 'ad',
          ${receipt.idempotencyKey}, ${receipt.externalId}, ${receipt.status}
        )
        on conflict (organization_id, provider, object_type, idempotency_key) do update set
          synced_at = now()
        where provider_objects.external_id = excluded.external_id
      `;
      await sql`
        insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
        values (
          ${crypto.randomUUID()}, ${receipt.organizationId}, ${receipt.brandId}, ${actorId},
          'publishing.confirmed', 'ad', ${receipt.externalId}, ${JSON.stringify(receipt)}
        )
      `;
    },
  };
}
