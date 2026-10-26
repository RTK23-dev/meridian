// The Content Factory chain for one repurposed cut, on the database the tests run on (PGlite here, Postgres when MERIDIAN_PG_TEST_URL is
// set). A delivered session is repurposed, an injected renderer renders the cut, an admin approves it, the cut's Meta upload receipt is
// stored, and the paused ad is created and read back. Each stage is the real function. Three things are fixtures: the renderer (not the
// cloud renderer), the upload receipt (written the way the upload writes it, because the upload's own call to Meta is not in this chain),
// and Meta (a fake that answers and counts every create). Nothing here is a live render or a live ad.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { FIXTURE_IDS, edlFixture } from "../../../engine/contracts/fixtures/index.ts";
import { writeArtifact } from "../../../engine/jobs/artifact-store.ts";
import { startEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import { defaultRepurposeSettings } from "../../../engine/repurpose/resolve.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { sealSecret } from "../oauth/flow.server.ts";
import { fakeMeta, type FakeMeta } from "../testing/meta-paused-fake.ts";
import { startRepurpose } from "./repurpose.ts";
import { recordRepurposeReview, repurposeReviewsOf } from "./repurpose-review.ts";
import { createRepurposedPausedAd, type CreatePausedAdOutcome } from "./repurpose-paused-ad.ts";
import { uploadRepurposeVariantToMeta } from "./repurpose-upload-service.ts";
import type { Transport } from "../providers/http.ts";

const WS = "ws_proof";
const BRAND = "brand_proof";
const ADMIN = "user_proof_admin";
const MEMBER = "user_proof_member";
const REQUEST = FIXTURE_IDS.request;
const SESSION = "session_proof_delivered";
const RENDERED_ARTIFACT = "art_proof_rendered_1";
const UPLOAD_VIDEO_ID = "meta_video_proof_1";
const AD_ACCOUNT = "act_9001";
const PAGE_ID = "1020";
const AD_SET_ID = "23851";
const OTHER_AD_SET_ID = "99999";
const DESTINATION = "https://example.com/offer";
const MESSAGE = "Watch the reel";
const ENCRYPTION_KEY = "proof-encryption-key-not-a-secret";
const NOW = "2026-10-24T10:00:00.000Z";

let db: TestDatabase;
let fake: FakeMeta;
let runId = "";
let variantKey = "";
let variantId = "";
let firstAdId = "";

/** The inputs the person enters on the paused-ad screen. The second ad set is the confirmation, so it matches the first. */
function input(adSetId: string) {
  return { sessionId: SESSION, runId, variantKey, adSetId, confirmAdSetId: adSetId, pageId: PAGE_ID, destinationUrl: DESTINATION, message: MESSAGE };
}

/** The options the server function passes: the encryption key from the environment, Meta's fake, and a fixed clock. */
function options() {
  return { env: { TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY }, transport: fake.transport, now: () => new Date(NOW) };
}

/** Counts the objects Meta received for one kind, as the fake recorded them. */
function createsOf(kind: "creative" | "ad"): number {
  return fake.posts.filter((post) => post.kind === kind).length;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  fake = fakeMeta({ adSetAccountId: "9001" });
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${ADMIN}, ${ADMIN}, ${`${ADMIN}@fixture.example`}, true)`;
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${MEMBER}, ${MEMBER}, ${`${MEMBER}@fixture.example`}, true)`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${ADMIN}`}, ${WS}, ${ADMIN}, 'admin')`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${MEMBER}`}, ${WS}, ${MEMBER}, 'member')`;

  // A delivered request: its master cut is the EDL fixture, stored as the finished run stores it.
  await startEngineRequest(db.sql as never, {
    organizationId: WS,
    brandId: BRAND,
    requestId: REQUEST,
    formatId: "ref_proof_fixture",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: "art_proof_request",
  });
  const masterArtifactId = (
    await writeArtifact(db.sql, { organizationId: WS, requestId: REQUEST, stage: "edit", type: "edl", body: edlFixture, createdAt: NOW })
  ).artifactId;
  const stored = await db.sql<{ state: string }>`select state from engine_requests where id = ${REQUEST} and organization_id = ${WS}`;
  const state = JSON.parse(stored[0]?.state ?? "{}") as Record<string, unknown> & { artifacts: Record<string, string> };
  await db.sql`
    update engine_requests set status = 'delivered', state = ${JSON.stringify({
      ...state,
      status: "delivered",
      manifestId: "mf_proof_fixture",
      masterEdlId: edlFixture.edlId,
      artifacts: { ...state.artifacts, [`edl:${edlFixture.edlId}`]: masterArtifactId },
    })}
    where id = ${REQUEST} and organization_id = ${WS}
  `;
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id)
    values (${SESSION}, ${WS}, ${BRAND}, ${ADMIN}, 'Proof reel', 'started', ${REQUEST})
  `;

  // Meta as the brand has connected it: the saved ad account, a saved Page, and a sealed access token for the workspace.
  await db.sql`
    insert into platform_accounts (id, organization_id, brand_id, platform, account_type, external_account_id, name)
    values ('pa_proof_ad', ${WS}, ${BRAND}, 'meta_ads', 'ad_account', ${AD_ACCOUNT}, 'Proof ad account')
  `;
  await db.sql`
    insert into platform_accounts (id, organization_id, brand_id, platform, account_type, external_account_id, name)
    values ('pa_proof_page', ${WS}, ${BRAND}, 'facebook', 'social_page', ${PAGE_ID}, 'Proof Page')
  `;
  const sealed = sealSecret("proof-access-token-not-logged", ENCRYPTION_KEY);
  assert.equal(typeof sealed, "string", "the fixture token must seal");
  await db.sql`insert into provider_secrets (id, organization_id, provider, sealed_token) values ('ps_proof_meta', ${WS}, 'meta', ${sealed as string})`;
});

after(async () => {
  await db.close();
});

describe("a repurposed cut, from a delivered session to a paused Meta ad", () => {
  test("the cut is repurposed and rendered by the injected renderer, and recorded as rendered", async () => {
    const run = await startRepurpose(
      db.sql,
      ADMIN,
      { sessionId: SESSION, settings: { ...defaultRepurposeSettings(), enabled: true, variantCount: 1 } },
      {
        renderPriceUsd: () => 0.2,
        render: async (child: { estimateUsd: number }) => {
          assert.equal(child.estimateUsd, 0.2, "the renderer is sent the verified price");
          return { status: "rendered" as const, artifactId: RENDERED_ARTIFACT };
        },
      },
    );
    assert.equal(run.variations.length, 1);
    const [cut] = run.variations;
    assert.equal(cut?.status, "rendered");
    assert.equal(cut?.renderedArtifactId, RENDERED_ARTIFACT);
    runId = run.runId;
    variantKey = cut!.key;

    const rows = await db.sql<{ id: string }>`
      select id from content_factory_repurpose_variants where run_id = ${runId} and variant_key = ${variantKey}
    `;
    variantId = rows[0]!.id;
  });

  test("an admin approves the rendered cut, and the approval shows in the review state", async () => {
    await recordRepurposeReview(db.sql, ADMIN, { sessionId: SESSION, runId, variantKey, decision: "approved", reason: "" });
    const reviews = await repurposeReviewsOf(db.sql, ADMIN, { sessionId: SESSION, runId });
    assert.equal(reviews[variantKey]?.status, "approved");
  });

  test("the real upload orchestration persists a fake-transport receipt idempotently, without publishing", async () => {
    const uploadRequests: Array<{ method: string; url: string }> = [];
    const uploadTransport: Transport = async (request) => {
      uploadRequests.push({ method: request.method, url: request.url });
      // The fake answers only the Meta video-list and upload endpoints. Any other upload-path request is an error,
      // and nothing can leave this injected transport.
      if (request.method === "GET" && request.url.includes("/advideos?")) {
        return { status: 200, body: JSON.stringify({ data: [] }), headers: {} };
      }
      if (request.method === "POST" && request.url.endsWith("/advideos")) {
        return { status: 200, body: JSON.stringify({ id: UPLOAD_VIDEO_ID }), headers: {} };
      }
      throw new Error(`unexpected request from upload orchestration: ${request.method} ${request.url}`);
    };
    const uploadOptions = {
      env: { TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY },
      readVideo: async (artifactId: string) => {
        assert.equal(artifactId, RENDERED_ARTIFACT, "the service reads this variation's rendered artifact");
        return new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
      },
      transport: uploadTransport,
    };
    const outcome = await uploadRepurposeVariantToMeta(db.sql, ADMIN, { sessionId: SESSION, runId, variantKey }, uploadOptions);
    assert.equal(outcome.status, "uploaded", "the real service and upload orchestration complete against the fake transport");
    if (outcome.status !== "uploaded") throw new Error("upload receipt was not persisted");
    assert.equal(outcome.receipt.externalId, UPLOAD_VIDEO_ID);
    assert.equal(outcome.receipt.variantId, variantId);
    assert.equal(outcome.receipt.platformAccountId, AD_ACCOUNT);

    const repeated = await uploadRepurposeVariantToMeta(db.sql, ADMIN, { sessionId: SESSION, runId, variantKey }, uploadOptions);
    assert.equal(repeated.status, "already_uploaded", "a repeated request returns the persisted receipt");
    if (repeated.status !== "already_uploaded") throw new Error("idempotent receipt was not returned");
    assert.equal(repeated.receipt.id, outcome.receipt.id);
    assert.equal(uploadRequests.length, 2, "the repeated request sends no additional upload or reconciliation calls");
    assert.deepEqual(uploadRequests.map((request) => request.method), ["GET", "POST"]);
    assert.ok(uploadRequests.every((request) => request.url.startsWith("https://graph.facebook.com/v21.0/")));
    assert.equal(uploadRequests.some((request) => request.url.endsWith("/ads") || request.url.endsWith("/adcreatives")), false,
      "the upload flow makes no ad creation or publish/activation call");
    const stored = await db.sql<{ external_id: string; idempotency_key: string }>`
      select external_id, idempotency_key from content_factory_repurpose_publications
      where organization_id = ${WS} and variant_id = ${variantId} and platform_account_id = ${AD_ACCOUNT} and kind = 'meta_ad_video'
    `;
    assert.equal(stored.length, 1, "exactly one upload receipt is persisted");
    assert.equal(stored[0]?.external_id, UPLOAD_VIDEO_ID);
    assert.equal(stored[0]?.idempotency_key, outcome.receipt.idempotencyKey);
  });

  test("the paused ad is created once, in the chosen ad set, PAUSED, and reads back as PAUSED", async () => {
    const outcome: CreatePausedAdOutcome = await createRepurposedPausedAd(db.sql, ADMIN, input(AD_SET_ID), options());
    assert.ok(outcome.status === "created_paused", `expected created_paused, got ${outcome.status}`);
    firstAdId = outcome.receipt.adId;
    assert.equal(outcome.receipt.verifiedStatus, "PAUSED");
    assert.equal(outcome.receipt.adSetId, AD_SET_ID);
    assert.equal(outcome.receipt.pageId, PAGE_ID);
    assert.equal(outcome.receipt.adAccountId, AD_ACCOUNT);
    assert.equal(outcome.receipt.destinationUrl, DESTINATION);

    assert.equal(createsOf("creative"), 1);
    assert.equal(createsOf("ad"), 1);
    const ad = fake.ads.find((item) => item.id === firstAdId);
    assert.ok(ad, "Meta holds the ad");
    assert.equal(ad.status, "PAUSED");
    assert.equal(ad.adsetId, AD_SET_ID);
    assert.equal(ad.accountId, "9001");
    const adCreate = fake.posts.find((post) => post.kind === "ad");
    assert.equal(adCreate?.body.status, "PAUSED", "the ad was sent to Meta paused");
  });

  test("a repeated request returns the same ad, and creates no second creative or ad", async () => {
    const again = await createRepurposedPausedAd(db.sql, ADMIN, input(AD_SET_ID), options());
    assert.ok(again.status === "already_created", `expected already_created, got ${again.status}`);
    assert.equal(again.receipt.adId, firstAdId);
    assert.equal(again.bindingMatches, true);
    assert.equal(createsOf("creative"), 1);
    assert.equal(createsOf("ad"), 1);
  });

  test("a request that changes the ad set after the ad exists returns the existing ad as not matching, and sends nothing to Meta", async () => {
    const changed = await createRepurposedPausedAd(db.sql, ADMIN, input(OTHER_AD_SET_ID), options());
    assert.ok(changed.status === "already_created", `expected already_created, got ${changed.status}`);
    assert.equal(changed.bindingMatches, false, "the request asks for another ad set than the one that exists");
    assert.equal(changed.receipt.adSetId, AD_SET_ID, "the receipt is still the ad that exists");
    assert.equal(createsOf("creative"), 1);
    assert.equal(createsOf("ad"), 1);
  });

  test("a member is refused before any operation is claimed, and nothing is sent to Meta", async () => {
    await assert.rejects(createRepurposedPausedAd(db.sql, MEMBER, input(AD_SET_ID), options()), /admin/i);
    assert.equal(createsOf("creative"), 1);
    assert.equal(createsOf("ad"), 1);
  });
});
