import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import type { Transport, TransportRequest, TransportResponse } from "../providers/http.ts";
import { registerDistributionChannel } from "../distribution/registry.ts";
import { YouTubeShortsChannel } from "../distribution/youtube.ts";
import { YOUTUBE_UPLOAD_SCOPE } from "../distribution/connection.ts";
import { listOrganicPosts, publishCreativeToChannels } from "../distribution/service.ts";
import { buildExportPackage } from "../distribution/export-package.ts";
import { storeVaultCredential } from "../vault/service.ts";
import { linkCreativeMeasurement } from "../measurement/creative-linkage.ts";
import { approveStage, runRow, studioTenant, type FactoryTenant } from "../testing/produce-fixtures.ts";
import { approveCreative, organicRowsFor, paidRowsFor, producedCreative, runFor, stage } from "../testing/factory-launch-fixtures.ts";

// The testing runtime enables the fixture paid publisher and the image double. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

test("intent both gives one organic receipt and one paused-ad receipt per creative", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "publish-both");
  const runId = await runFor(sql, tenant, "full", "both", ["youtube"]);
  const creativeId = await producedCreative(sql, tenant, runId, "full");
  await approveCreative(sql, creativeId);

  const summary = await stage(sql, tenant, runId, "factory.launch");
  assert.equal(summary, "launched:organic=0;not_connected=1;paid_paused=1;failed=0;unapproved=0;blocked=0");

  const organic = await organicRowsFor(sql, tenant, creativeId);
  assert.equal(organic.length, 1, "one organic receipt for the one platform");
  assert.equal(organic[0]?.platform, "youtube");
  assert.equal(organic[0]?.surface, "organic");
  assert.equal(organic[0]?.status, "not_connected", "no YouTube account is connected, so the receipt says so");
  assert.match(organic[0]?.error ?? "", /YouTube/, "the receipt names the reason");

  const paid = await paidRowsFor(sql, tenant, creativeId);
  const ads = paid.filter((row) => row.object_type === "ad");
  assert.equal(ads.length, 1, "one paid receipt for the ad");
  assert.equal(ads[0]?.status, "paused");
  assert.equal(ads[0]?.surface, "paid");
  assert.equal(ads[0]?.provider, "test");
  assert.match(ads[0]?.external_id ?? "", /^test_ad_[0-9a-f]{12}$/);
  assert.deepEqual(
    paid.map((row) => row.object_type),
    ["ad", "ad_set", "campaign", "creative"],
    "the campaign, ad set, creative and ad are each recorded",
  );
  for (const row of paid) assert.equal(row.status, "paused", `${row.object_type} is recorded as paused, never active`);
  assert.equal(paid.some((row) => row.status === "active"), false);

  const published = await sql<{ n: number }>`
    select count(*)::int as n from organic_posts
    where organization_id = ${tenant.organizationId} and creative_id = ${creativeId} and status = 'published'
  `;
  assert.equal(published[0]?.n, 0, "a not-connected channel is never counted as published");

  const linked = await linkCreativeMeasurement(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId });
  assert.ok(linked);
  assert.ok(linked.publishReceipts.length > 0, "the confirmed paid objects are publish receipts");
  assert.ok(linked.publishReceipts.every((receipt) => receipt.surface === "paid"), "every confirmed receipt names the paid surface");
  assert.equal(linked.publishReceipts.filter((receipt) => receipt.objectType === "ad").length, 1, "one paid ad receipt");
  assert.equal(linked.publishReceipts.some((receipt) => receipt.surface === "organic"), false, "the not-connected organic receipt is not a publish receipt");
});

test("a not-connected organic channel records not_connected, leaves the creative approved, and is not listed as published", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "publish-not-connected");
  const runId = await runFor(sql, tenant, "full", "organic", ["instagram", "youtube"]);
  const creativeId = await producedCreative(sql, tenant, runId, "full");
  await approveCreative(sql, creativeId);

  assert.equal(await stage(sql, tenant, runId, "factory.launch"), "launched:organic=0;not_connected=2;paid_paused=0;failed=0;unapproved=0;blocked=0");
  const organic = await organicRowsFor(sql, tenant, creativeId);
  assert.deepEqual(organic.map((row) => row.status).sort(), ["not_connected", "not_connected"]);
  assert.deepEqual(organic.map((row) => row.platform).sort(), ["instagram", "youtube"], "each platform is listed, none is hidden");

  const [creative] = await sql<{ status: string }>`select status from creative_records where id = ${creativeId}`;
  assert.equal(creative?.status, "approved", "a receipt that was not sent does not move the creative to testing");

  const posts = await listOrganicPosts(sql, tenant.organizationId, tenant.brandId);
  assert.equal(posts.filter((post) => post.creativeId === creativeId && post.status === "published").length, 0);
  assert.equal(await paidRowsFor(sql, tenant, creativeId).then((rows) => rows.length), 0, "organic-only intent writes no paid receipt");
});

test("an unapproved creative never reaches publish, on either path", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "publish-unapproved");
  const runId = await runFor(sql, tenant, "full", "both", ["youtube"]);
  const creativeId = await producedCreative(sql, tenant, runId, "full");
  await sql`update creative_records set status = 'in_review', updated_at = now() where id = ${creativeId}`;

  assert.equal(await stage(sql, tenant, runId, "factory.launch"), "launched:organic=0;not_connected=0;paid_paused=0;failed=0;unapproved=1;blocked=0;nothing-approved");
  assert.equal((await organicRowsFor(sql, tenant, creativeId)).length, 0, "no organic receipt is written for a creative a person has not approved");
  assert.equal((await paidRowsFor(sql, tenant, creativeId)).length, 0, "no paid object is written for a creative a person has not approved");
});

test("a creative the gate blocks does not publish, even when a person approved it", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "publish-blocked");
  const runId = await runFor(sql, tenant, "full", "ad", []);
  const creativeId = await producedCreative(sql, tenant, runId, "full");
  await approveCreative(sql, creativeId);
  await sql`
    update factory_variants set gate_result = 'block'
    where id in (select variant_id from factory_creatives where creative_id = ${creativeId})
  `;

  assert.equal(await stage(sql, tenant, runId, "factory.launch"), "launched:organic=0;not_connected=0;paid_paused=0;failed=0;unapproved=0;blocked=1;nothing-approved");
  assert.equal((await paidRowsFor(sql, tenant, creativeId)).length, 0);
});

test("manual and semi hold publish until a person approves the launch, then publish once", async () => {
  const sql = await getSql();
  for (const automation of ["manual", "semi"] as const) {
    const tenant = await studioTenant(sql, `publish-hold-${automation}`);
    const runId = await runFor(sql, tenant, automation, "both", ["youtube"]);
    const creativeId = await producedCreative(sql, tenant, runId, automation);
    await approveCreative(sql, creativeId);

    assert.equal(await stage(sql, tenant, runId, "factory.launch"), "awaiting-approval:factory.launch", `${automation} waits before publish`);
    assert.equal((await organicRowsFor(sql, tenant, creativeId)).length, 0, `${automation}: no organic receipt before approval`);
    assert.equal((await paidRowsFor(sql, tenant, creativeId)).length, 0, `${automation}: no paid object before approval`);
    const waiting = await runRow(sql, tenant, runId);
    assert.equal(waiting.status, "awaiting_approval");
    assert.equal(waiting.current_stage, "factory.launch");

    await approveStage(sql, tenant, runId, "factory.launch");
    assert.match(await stage(sql, tenant, runId, "factory.launch"), /^launched:organic=0;not_connected=1;paid_paused=1;/);
    assert.equal((await paidRowsFor(sql, tenant, creativeId)).filter((row) => row.object_type === "ad").length, 1);
  }
});

test("the export package is produced for a creative whatever its channels say, approved or not", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "publish-export");
  const runId = await runFor(sql, tenant, "full", "organic", ["youtube"]);
  const creativeId = await producedCreative(sql, tenant, runId, "full");
  const scope = { organizationId: tenant.organizationId, brandId: tenant.brandId };

  const beforeLaunch = await buildExportPackage(sql, scope, creativeId);
  assert.ok(beforeLaunch, "the package exists before any channel is tried");
  assert.ok(beforeLaunch.files.length >= 1, "the package lists the stored asset");
  assert.match(beforeLaunch.files[0]?.mimeType ?? "", /^image\//);

  await stage(sql, tenant, runId, "factory.launch");
  const afterLaunch = await buildExportPackage(sql, scope, creativeId);
  assert.ok(afterLaunch, "the package is still produced after a not-connected launch");
  assert.equal(afterLaunch.creativeId, creativeId);
  assert.equal((await buildExportPackage(sql, { organizationId: tenant.organizationId, brandId: "other-brand" }, creativeId)), null, "another brand does not see it");
});

test("the test stage records what it would do, waits for a person, and switches nothing on", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "publish-test-stage");
  const runId = await runFor(sql, tenant, "full", "ad", []);
  const creativeId = await producedCreative(sql, tenant, runId, "full");
  await approveCreative(sql, creativeId);
  assert.match(await stage(sql, tenant, runId, "factory.launch"), /paid_paused=1/);

  assert.equal(await stage(sql, tenant, runId, "factory.test"), "awaiting-approval:factory.test", "full waits for a person at the test stage too");
  const waiting = await runRow(sql, tenant, runId);
  assert.equal(waiting.status, "awaiting_approval");
  assert.equal(waiting.current_stage, "factory.test");

  await approveStage(sql, tenant, runId, "factory.test");
  assert.equal(await stage(sql, tenant, runId, "factory.test"), "test:recorded;paused-ads=1;switched-on=0");
  const paid = await paidRowsFor(sql, tenant, creativeId);
  assert.equal(paid.some((row) => row.status === "active"), false, "no paid object is active after the test stage");
  const audits = await sql<{ n: number }>`
    select count(*)::int as n from audit_log
    where organization_id = ${tenant.organizationId} and action = 'factory.test.recorded' and object_id = ${runId}
  `;
  assert.equal(audits[0]?.n, 1, "the recorded test is kept in the audit log");
});

test("a connected YouTube channel publishes the stored video through its transport, and the post is recorded", async () => {
  const KEY = `publish-fixture-key-${randomUUID()}`;
  const prior = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  try {
    const sql = await getSql();
    const tenant = await studioTenant(sql, "publish-youtube-fixture");
    const creativeId = await insertVideoCreative(sql, tenant);
    const credential = await storeVaultCredential(
      sql,
      tenant.organizationId,
      "oauth_token",
      { accessToken: "fixture-youtube-token", customFields: { scopes: [YOUTUBE_UPLOAD_SCOPE] } },
      { masterKey: KEY },
    );
    await sql`
      insert into platform_accounts (id, organization_id, brand_id, platform, account_type, external_account_id, name, credential_id, status)
      values (${`acct-${creativeId}`}, ${tenant.organizationId}, ${tenant.brandId}, 'youtube', 'channel', 'UC-fixture-1', 'Fixture Channel',
        ${credential.id}, 'connected')
    `;
    const fixture = youtubeUploadFixture();
    registerDistributionChannel(new YouTubeShortsChannel({ transport: fixture.transport }));

    const [receipt] = await publishCreativeToChannels(sql, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      creativeId,
      channelIds: ["youtube-shorts"],
      userId: tenant.userId,
    });
    assert.equal(receipt?.status, "published");
    assert.equal(receipt?.surface, "organic");
    assert.equal(receipt?.externalId, "yt-fixture-1");
    assert.equal(fixture.requests.length, 2, "one request opens the upload, one sends the bytes");

    const posts = await organicRowsFor(sql, tenant, creativeId);
    assert.deepEqual(posts.map((row) => [row.platform, row.status, row.surface]), [["youtube", "published", "organic"]]);
    const [creative] = await sql<{ status: string }>`select status from creative_records where id = ${creativeId}`;
    assert.equal(creative?.status, "testing", "a published organic post moves the creative to testing, as Studio does");
  } finally {
    if (prior === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = prior;
  }
});

/**
 * A video creative the way the video path stores one: a creative row, an asset row, and the stored bytes. The bytes are a fixture
 * with an MP4 `ftyp` header, not a rendered video. The channel checks the MIME type and that the bytes are not empty.
 */
async function insertVideoCreative(sql: Sql, tenant: FactoryTenant): Promise<string> {
  const creativeId = `creative-video-${randomUUID()}`;
  const storageKey = `fixture/video/${creativeId}.mp4`;
  const bytes = Buffer.from("0000001866747970336770350000000000000000", "hex");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
      message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
    ) values (
      ${creativeId}, ${tenant.organizationId}, ${tenant.brandId}, 'generated', 'Fixture video', 'Fixture caption', 'Mesh sponge',
      '', '', '', '', '', 'video', '', null, ${tenant.briefId}, 'approved', ${tenant.userId}, '{}'
    )
  `;
  await sql`
    insert into assets (
      id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
      lifecycle, checksum, width, height, byte_size, provider, model, prompt_version, generation_run_id, kind,
      qa_decision, review_status, media_status, variant_index, provenance
    ) values (
      ${`asset-${creativeId}`}, ${tenant.organizationId}, ${tenant.brandId}, ${creativeId}, 1, ${storageKey}, ${digest},
      'video/mp4', 'fixture', 'stored', 'qa_required', ${digest}, 1, 1, ${bytes.byteLength}, 'fixture', '', '', '', 'video',
      'AUTO_APPROVE', 'approved', 'completed', 0, 'generated'
    )
  `;
  await sql`
    insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, lifecycle)
    values (${storageKey}, ${tenant.organizationId}, ${tenant.brandId}, ${bytes.toString("base64")}, 'video/mp4', ${digest},
      ${bytes.byteLength}, 'stored')
  `;
  return creativeId;
}

/**
 * The YouTube Data API resumable upload, answered the way its documentation describes: the first request opens a session and
 * returns its URL in the Location header, and the second sends the bytes and returns the video resource with its id.
 * https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol and https://developers.google.com/youtube/v3/docs/videos/insert
 * This is a fixture. No request leaves the process.
 */
function youtubeUploadFixture() {
  const requests: TransportRequest[] = [];
  const transport: Transport = async (request): Promise<TransportResponse> => {
    requests.push(request);
    if (request.method === "POST") {
      return { status: 200, body: "", headers: { location: "https://upload.fixture.invalid/session/1" } };
    }
    return { status: 200, body: JSON.stringify({ kind: "youtube#video", id: "yt-fixture-1" }), headers: {} };
  };
  return { transport, requests };
}
