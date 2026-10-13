import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { factoryRunFor, planRowsFor, stageJob, stubImageProvider, studioTenant, type FactoryTenant } from "../testing/produce-fixtures.ts";
import type { Sql } from "../learning/store.ts";
import { rightsGate } from "./gates.ts";

// The testing runtime enables the image double and the testing artifact store. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";
enableAppAliases();
const { executeFactoryJob } = await import("./worker.ts");
const { creativeIdsOfVariant, licencesForCreatives, variantLicenceFlags, variantRightsView } = await import("./rights.ts");
const { attestLicence, revokeLicence } = await import("./rights-service.ts");

/** One produced creative for a variant of a run, so a licence has a real creative to attest. */
async function producedCreative(sql: Sql, tenant: FactoryTenant) {
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" }, caps: { totalCents: 500 } });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider();
  try {
    await executeFactoryJob(sql, stageJob(tenant, runId, "factory.produce"), { runId });
  } finally {
    stub.restore();
  }
  const [link] = await sql<{ creative_id: string }>`select creative_id from factory_creatives where run_id = ${runId}`;
  assert.ok(link, "a creative was produced for the variant");
  return { runId, variantId: variantId!, creativeId: link.creative_id };
}

/** The rights reason for a variant, read the way the Factory screen reads it: from the attestations stored now. */
async function rightsOf(sql: Sql, tenant: FactoryTenant, variantId: string) {
  const creativeIds = await creativeIdsOfVariant(sql, tenant.organizationId, tenant.brandId, variantId);
  const licences = await licencesForCreatives(sql, tenant.organizationId, tenant.brandId, creativeIds);
  return { flags: variantLicenceFlags(creativeIds, licences), view: variantRightsView(creativeIds, licences) };
}

async function gateResultOf(sql: Sql, tenant: FactoryTenant, variantId: string): Promise<string> {
  const [row] = await sql<{ gate_result: string }>`select gate_result from factory_variants where id = ${variantId}`;
  return row!.gate_result;
}

test("the rights gate passes only when both licences are attested, and names a missing licence", () => {
  assert.equal(rightsGate({ musicLicensed: false, footageLicensed: true, aiLabeled: true }).reason, "no licence attested for music");
  assert.equal(rightsGate({ musicLicensed: true, footageLicensed: false, aiLabeled: true }).reason, "no licence attested for footage");
  assert.equal(rightsGate({ musicLicensed: true, footageLicensed: true, aiLabeled: true }).result, "pass", "attested licences and AI labelling pass");
  assert.equal(rightsGate({ musicLicensed: true, footageLicensed: true, aiLabeled: false }).result, "block", "the AI labelling rule is unchanged");
});

test("a variant with no attestation is blocked with the reason, and the gate stores the block", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "rights-none");
  const { runId, variantId } = await producedCreative(sql, tenant);
  const { flags, view } = await rightsOf(sql, tenant, variantId);
  assert.deepEqual(flags, { musicLicensed: false, footageLicensed: false });
  assert.equal(view.blockedBy, "no licence attested for music");

  await executeFactoryJob(sql, stageJob(tenant, runId, "factory.gate"), { runId });
  assert.equal(await gateResultOf(sql, tenant, variantId), "block", "the gate stage blocks the variant with no licence");
});

test("attesting both licences clears the licence reasons, and each attestation keeps the fixed wording", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "rights-attest");
  const { creativeId, variantId } = await producedCreative(sql, tenant);

  const music = await attestLicence(sql, tenant.userId, { brandId: tenant.brandId, creativeId, kind: "music" });
  assert.equal(music.created, true);
  assert.match(music.wording, /licence for the music/);
  assert.equal((await rightsOf(sql, tenant, variantId)).view.blockedBy, "no licence attested for footage");

  const footage = await attestLicence(sql, tenant.userId, { brandId: tenant.brandId, creativeId, kind: "footage" });
  assert.equal(footage.created, true);
  const { flags, view } = await rightsOf(sql, tenant, variantId);
  assert.deepEqual(flags, { musicLicensed: true, footageLicensed: true }, "both licences are attested for the creative");
  // The licences pass. The rights gate still reads its AI labelling input, which has no source yet, so it blocks on that.
  assert.match(view.blockedBy ?? "", /not labelled/);
  assert.equal(await gateResultOf(sql, tenant, variantId), "block", "the stored gate result follows the attestation at once");

  const [stored] = await sql<{ wording: string; attested_by: string; revoked_at: unknown }>`
    select wording, attested_by, revoked_at from rights_attestations where id = ${music.attestationId}
  `;
  assert.equal(stored?.wording, music.wording, "the stored wording is the fixed wording for the kind");
  assert.equal(stored?.attested_by, tenant.userId, "the row records who attested");
  assert.equal(stored?.revoked_at, null);
});

test("attesting the same licence again returns the existing attestation", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "rights-again");
  const { creativeId } = await producedCreative(sql, tenant);
  const first = await attestLicence(sql, tenant.userId, { brandId: tenant.brandId, creativeId, kind: "music" });
  const second = await attestLicence(sql, tenant.userId, { brandId: tenant.brandId, creativeId, kind: "music" });
  assert.equal(second.created, false);
  assert.equal(second.attestationId, first.attestationId);
});

test("a revoked attestation blocks again, and its row is kept with revoked_at set", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "rights-revoke");
  const { creativeId, variantId } = await producedCreative(sql, tenant);
  await attestLicence(sql, tenant.userId, { brandId: tenant.brandId, creativeId, kind: "music" });
  const footage = await attestLicence(sql, tenant.userId, { brandId: tenant.brandId, creativeId, kind: "footage" });
  assert.equal((await rightsOf(sql, tenant, variantId)).flags.footageLicensed, true);

  const revoked = await revokeLicence(sql, tenant.userId, { brandId: tenant.brandId, attestationId: footage.attestationId });
  assert.equal(revoked.kind, "footage");
  const { flags, view } = await rightsOf(sql, tenant, variantId);
  assert.equal(flags.footageLicensed, false);
  assert.equal(view.blockedBy, "no licence attested for footage", "the revoked licence blocks the variant again");

  const [row] = await sql<{ revoked_at: unknown; attested_by: string }>`select revoked_at, attested_by from rights_attestations where id = ${footage.attestationId}`;
  assert.ok(row?.revoked_at, "the revoked row is kept, with its time");
  assert.equal(row?.attested_by, tenant.userId, "who attested is not lost");
  await assert.rejects(
    () => revokeLicence(sql, tenant.userId, { brandId: tenant.brandId, attestationId: footage.attestationId }),
    /No active attestation/,
    "a revoked attestation cannot be revoked again",
  );
});

test("another brand's attestation does not count for this brand's creative", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "rights-brand-a");
  const other = await studioTenant(sql, "rights-brand-b");
  const { creativeId, variantId } = await producedCreative(sql, tenant);
  // An attestation written under the other brand, naming this brand's creative. It must never count here.
  await sql`
    insert into rights_attestations (id, organization_id, brand_id, asset_id, kind, attested_by, wording)
    values ('rights-cross-brand', ${other.organizationId}, ${other.brandId}, ${creativeId}, 'music', ${other.userId}, 'cross brand')
  `;
  const { flags, view } = await rightsOf(sql, tenant, variantId);
  assert.equal(flags.musicLicensed, false, "the other brand's music attestation is not this brand's licence");
  assert.equal(view.blockedBy, "no licence attested for music");
});

test("a viewer cannot attest or revoke a licence, and nothing is written", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "rights-viewer");
  const { creativeId, variantId } = await producedCreative(sql, tenant);
  await sql`update memberships set role = 'viewer' where user_id = ${tenant.userId} and organization_id = ${tenant.organizationId}`;
  await assert.rejects(
    () => attestLicence(sql, tenant.userId, { brandId: tenant.brandId, creativeId, kind: "music" }),
    /do not have permission/,
  );
  const [count] = await sql<{ n: number }>`select count(*)::int as n from rights_attestations where brand_id = ${tenant.brandId}`;
  assert.equal(count?.n, 0, "a refused attest writes no row");
  assert.equal((await rightsOf(sql, tenant, variantId)).view.blockedBy, "no licence attested for music");
});

test("an unknown licence kind and a creative from another brand are refused", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "rights-refuse");
  const other = await studioTenant(sql, "rights-refuse-other");
  const { creativeId } = await producedCreative(sql, tenant);
  await assert.rejects(() => attestLicence(sql, tenant.userId, { brandId: tenant.brandId, creativeId, kind: "logo" }), /music or the footage/);
  await assert.rejects(
    () => attestLicence(sql, other.userId, { brandId: other.brandId, creativeId, kind: "music" }),
    /not in this brand/,
  );
});
