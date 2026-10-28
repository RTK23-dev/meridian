// The Meta video upload through its production default, on the database the tests run on. The variation is rendered, approved, and the
// brand has a connected Meta ad account and token. Two cases, both with no transport injected and every request counted:
//   - The rendered video cannot be read from the object store (no Drive connection here), so the upload is blocked before any request.
//   - The video bytes are readable (a fixture stands in for the object store read), so the upload reaches the production default transport,
//     which is the publish.meta_video_upload gate. The outcome is failed with the gate's message, and no request is sent.
// Both cases assert that no upload receipt is stored. The object store read itself is not exercised here: the Drive tests cover it.
//
// The last block drives the same service, receipt store and paused-ad state machine through an injected fake Meta (no gate involved), and
// asserts the upload receipt, idempotency, a PAUSED ad, no activation call, and that no request escapes the fake.

import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";
import { FIXTURE_IDS, edlFixture } from "../../../engine/contracts/fixtures/index.ts";
import { writeArtifact } from "../../../engine/jobs/artifact-store.ts";
import { startEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import { defaultRepurposeSettings } from "../../../engine/repurpose/resolve.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { sealSecret } from "../oauth/flow.server.ts";
import type { Transport, TransportRequest } from "../providers/http.ts";
import { fakeMeta } from "../../../test-support/lib/meridian/testing/meta-paused-fake.ts";
import { createRepurposedPausedAd } from "./repurpose-paused-ad.ts";
import { startRepurpose } from "./repurpose.ts";
import { recordRepurposeReview } from "./repurpose-review.ts";
import { sqlRepurposeUploadStore } from "./repurpose-upload.ts";
import { uploadRepurposeVariantToMeta } from "./repurpose-upload-service.ts";

const WS = "ws_upload_default";
const BRAND = "brand_upload_default";
const ADMIN = "user_upload_default_admin";
const REQUEST = FIXTURE_IDS.request;
const SESSION = "session_upload_default";
const AD_ACCOUNT = "act_9100";
const KEY = "upload-default-encryption-key-not-a-secret";
const NOW = "2026-10-24T10:00:00.000Z";

let db: TestDatabase;
let runId = "";
let variantKey = "";
let requests = 0;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${ADMIN}, ${ADMIN}, ${`${ADMIN}@fixture.example`}, true)`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${ADMIN}`}, ${WS}, ${ADMIN}, 'admin')`;

  // A delivered request, as the finished run stores it, and a session on it.
  await startEngineRequest(db.sql as never, {
    organizationId: WS,
    brandId: BRAND,
    requestId: REQUEST,
    formatId: "ref_upload_default",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: "art_upload_default_request",
  });
  const masterArtifactId = (await writeArtifact(db.sql, { organizationId: WS, requestId: REQUEST, stage: "edit", type: "edl", body: edlFixture, createdAt: NOW })).artifactId;
  const stored = await db.sql<{ state: string }>`select state from engine_requests where id = ${REQUEST} and organization_id = ${WS}`;
  const state = JSON.parse(stored[0]?.state ?? "{}") as Record<string, unknown> & { artifacts: Record<string, string> };
  await db.sql`
    update engine_requests set status = 'delivered', state = ${JSON.stringify({
      ...state,
      status: "delivered",
      manifestId: "mf_upload_default",
      masterEdlId: edlFixture.edlId,
      artifacts: { ...state.artifacts, [`edl:${edlFixture.edlId}`]: masterArtifactId },
    })}
    where id = ${REQUEST} and organization_id = ${WS}
  `;
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id)
    values (${SESSION}, ${WS}, ${BRAND}, ${ADMIN}, 'Upload default', 'started', ${REQUEST})
  `;

  // One rendered, approved variation: its status is what the upload's readiness check reads.
  const run = await startRepurpose(
    db.sql,
    ADMIN,
    { sessionId: SESSION, settings: { ...defaultRepurposeSettings(), enabled: true, variantCount: 1 } },
    { renderPriceUsd: () => 0.2, render: async () => ({ status: "rendered" as const, artifactId: "art_upload_default_rendered" }) },
  );
  runId = run.runId;
  variantKey = run.variations[0]!.key;
  // The variation's rendered video is stored, so the upload reaches the read of its bytes, which goes through Google Drive.
  const video = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQUEST,
    stage: "render",
    type: "rendered_video",
    body: {
      videoId: `vid_01HZ${"0".repeat(21)}1`,
      edlId: edlFixture.edlId,
      uri: "store://renders/vid_upload_default.mp4",
      renderer: "hyperframes-cloud",
      durationMs: edlFixture.durationMs,
      bytes: 16,
      estimateUsd: 0.05,
      costUsd: null,
      idempotencyKey: `sha256:${"a".repeat(64)}`,
    },
    createdAt: NOW,
  });
  await db.sql`update content_factory_repurpose_variants set rendered_artifact_id = ${video.artifactId} where run_id = ${runId} and variant_key = ${variantKey}`;
  // The approval is recorded on the video that is now stored. A review of an earlier video would not count for it.
  await recordRepurposeReview(db.sql, ADMIN, { sessionId: SESSION, runId, variantKey, decision: "approved", reason: "" });

  // The brand's connected Meta ad account and token, as the Connected accounts screen stores them.
  await db.sql`
    insert into platform_accounts (id, organization_id, brand_id, platform, account_type, external_account_id, name)
    values ('pa_upload_default_ad', ${WS}, ${BRAND}, 'meta_ads', 'ad_account', ${AD_ACCOUNT}, 'Upload default account')
  `;
  const sealed = sealSecret("upload-default-token-not-logged", KEY);
  assert.equal(typeof sealed, "string", "the fixture token must seal");
  await db.sql`insert into provider_secrets (id, organization_id, provider, sealed_token) values ('ps_upload_default', ${WS}, 'meta', ${sealed as string})`;

  // Every request that the default path would make is counted. Any call to fetch fails the test.
  mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new Error("The default upload path reached the network.");
  });
});

after(async () => {
  mock.restoreAll();
  await db.close();
});

describe("the Meta video upload fails closed through its production default", () => {
  test("with the default transport and a connected Meta account, the upload is blocked before any request, and no receipt is stored", async () => {
    const outcome = await uploadRepurposeVariantToMeta(db.sql, ADMIN, { sessionId: SESSION, runId, variantKey }, { env: { TOKEN_ENCRYPTION_KEY: KEY } });
    assert.equal(outcome.status, "blocked", "the upload is blocked, not reported as uploaded");
    assert.match(outcome.reason, /not stored|could not be read/, "it stops at the rendered video, whose bytes are not read here");
    assert.equal(requests, 0, "no request is sent to Google Drive or to Meta");
    const receipt = await sqlRepurposeUploadStore(db.sql).find(WS, await variantIdOf(), AD_ACCOUNT);
    assert.equal(receipt, null, "no upload receipt is stored");
  });

  test("with readable video bytes, the production default transport refuses before any Meta request, and no receipt is stored", async () => {
    const outcome = await uploadRepurposeVariantToMeta(
      db.sql,
      ADMIN,
      { sessionId: SESSION, runId, variantKey },
      { env: { TOKEN_ENCRYPTION_KEY: KEY }, readVideo: async () => new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) },
    );
    assert.ok(outcome.status === "failed", "the refused upload is reported as failed, not as uploaded");
    assert.match(outcome.error, /off in this build, so nothing was sent/, "the refusal is the publish.meta_video_upload gate's");
    assert.equal(requests, 0, "no request is sent to Meta");
    const receipt = await sqlRepurposeUploadStore(db.sql).find(WS, await variantIdOf(), AD_ACCOUNT);
    assert.equal(receipt, null, "no upload receipt is stored");
  });
});

/** The variation's id, read from the run the test created. */
async function variantIdOf(): Promise<string> {
  const [row] = await db.sql<{ id: string }>`select id from content_factory_repurpose_variants where run_id = ${runId} and variant_key = ${variantKey}`;
  return row?.id ?? "";
}

// The real upload service and paused-ad state machine, with Meta replaced by a fake. Nothing here is the production default transport,
// so the gate is not involved; the point is the receipt, the idempotency and the paused state. The global fetch counter stays on.
describe("the Meta upload and the paused ad, through an injected fake Meta", () => {
  const PAGE_ID = "1020";
  const AD_SET_ID = "23851";
  const meta = fakeMeta({ adSetAccountId: "9100" });
  const sent: TransportRequest[] = [];
  const videos: { id: string; title: string }[] = [];
  const transport: Transport = async (request) => {
    sent.push(request);
    if (/\/act_9100\/advideos/.test(request.url)) {
      if (request.method === "GET") return { status: 200, body: JSON.stringify({ data: videos }), headers: {} };
      const title = String((request.body as FormData).get("title"));
      const id = `vid_fake_${videos.length + 1}`;
      videos.push({ id, title });
      return { status: 200, body: JSON.stringify({ id }), headers: {} };
    }
    return meta.transport(request);
  };
  const bytes = async () => new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  const input = () => ({ sessionId: SESSION, runId, variantKey });
  const posts = () => sent.filter((request) => request.method === "POST");

  before(async () => {
    await db.sql`
      insert into platform_accounts (id, organization_id, brand_id, platform, account_type, external_account_id, name)
      values ('pa_upload_default_page', ${WS}, ${BRAND}, 'facebook', 'social_page', ${PAGE_ID}, 'Upload default page')
    `;
  });

  test("the upload goes to the fake once, and its receipt holds the fake's video id", async () => {
    const outcome = await uploadRepurposeVariantToMeta(db.sql, ADMIN, input(), { env: { TOKEN_ENCRYPTION_KEY: KEY }, readVideo: bytes, transport });
    assert.ok(outcome.status === "uploaded", `expected uploaded, got ${outcome.status}`);
    assert.equal(outcome.receipt.externalId, "vid_fake_1");
    const stored = await sqlRepurposeUploadStore(db.sql).find(WS, await variantIdOf(), AD_ACCOUNT);
    assert.equal(stored?.externalId, "vid_fake_1", "the receipt is persisted");
    assert.equal(posts().filter((request) => /\/advideos$/.test(request.url)).length, 1, "one upload POST");
    assert.equal(requests, 0, "no request escaped the fake");
  });

  test("a second upload is answered from the receipt: nothing is sent and no second video exists", async () => {
    const before = sent.length;
    const outcome = await uploadRepurposeVariantToMeta(db.sql, ADMIN, input(), { env: { TOKEN_ENCRYPTION_KEY: KEY }, readVideo: bytes, transport });
    assert.equal(outcome.status, "already_uploaded");
    assert.equal(sent.length, before, "no request on the repeat");
    assert.equal(videos.length, 1);
  });

  test("the paused ad is created PAUSED from the receipt's video, and a repeat creates nothing", async () => {
    const adInput = { ...input(), adSetId: AD_SET_ID, confirmAdSetId: AD_SET_ID, pageId: PAGE_ID, destinationUrl: "https://example.test/offer", message: "Proof" };
    const created = await createRepurposedPausedAd(db.sql, ADMIN, adInput, { env: { TOKEN_ENCRYPTION_KEY: KEY }, transport });
    assert.ok(created.status === "created_paused", `expected created_paused, got ${created.status}`);
    assert.equal(created.receipt.verifiedStatus, "PAUSED");
    assert.equal(meta.ads.length, 1);
    assert.equal(meta.ads[0]?.status, "PAUSED", "the ad exists in the fake as PAUSED");
    assert.equal((meta.posts.find((post) => post.kind === "ad")?.body.status), "PAUSED", "the create request asked for PAUSED");
    assert.equal(created.receipt.adId, meta.ads[0]?.id);

    const before = posts().length;
    const again = await createRepurposedPausedAd(db.sql, ADMIN, adInput, { env: { TOKEN_ENCRYPTION_KEY: KEY }, transport });
    assert.equal(again.status, "already_created");
    assert.equal(posts().length, before, "the repeat sent no create");
    assert.equal(meta.ads.length, 1, "still one ad");
  });

  test("across the whole chain there is no activation or publish call, and no request left the fake", () => {
    for (const request of posts()) {
      assert.match(request.url, /\/act_9100\/(advideos|adcreatives|ads)$/, `unexpected POST ${request.url}`);
    }
    assert.equal(sent.some((request) => /publish|activate|ACTIVE/i.test(request.url)), false);
    assert.equal(meta.posts.some((post) => post.body.status !== undefined && post.body.status !== "PAUSED"), false, "every create asks for PAUSED");
    assert.equal(requests, 0, "global fetch was never called");
  });
});
