// Repurposing a delivered Content Factory video, on PGlite: the master is read from the engine request that delivered it, each variation is a
// child cut recorded under that request, and nothing is rendered without a verified price. The priced cases inject a price and a renderer to
// exercise the recording and the retries. They do not reach a provider, so they are not evidence of a live render.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { FIXTURE_IDS, edlFixture } from "../../../engine/contracts/fixtures/index.ts";
import { writeArtifact } from "../../../engine/jobs/artifact-store.ts";
import { startEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import { defaultRepurposeSettings } from "../../../engine/repurpose/resolve.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { RENDER_PRICE_NOT_VERIFIED, RENDERER_NOT_CONNECTED, repurposeOutputLink, repurposePreview, startRepurpose } from "./repurpose.ts";
import { recordRepurposeReview, repurposeReviewsOf } from "./repurpose-review.ts";
import { sqlRepurposeUploadStore } from "./repurpose-upload.ts";
import { uploadRepurposeVariantToMeta } from "./repurpose-upload-service.ts";

const WS = "ws_repurpose";
const BRAND = "brand_repurpose";
const ADMIN = "user_repurpose_admin";
const MEMBER = "user_repurpose_member";
const DELIVERED_REQUEST = FIXTURE_IDS.request;
const UNDELIVERED_REQUEST = "req_01HZREPURPOSE00000000000001";
const DELIVERED_SESSION = "session_repurpose_delivered";
const UNDELIVERED_SESSION = "session_repurpose_undelivered";
const NOW = "2026-10-24T10:00:00.000Z";

let db: TestDatabase;
let masterArtifactId = "";

/** Settings that make a repurpose on the default categories, with the given count and no other change. */
function settings(variantCount: number) {
  return { ...defaultRepurposeSettings(), enabled: true, variantCount };
}

async function childArtifactCount(): Promise<number> {
  const rows = await db.sql<{ n: number }>`
    select count(*)::int as n from engine_artifacts where request_id = ${DELIVERED_REQUEST} and type = 'edl' and stage = 'repurpose'
  `;
  return rows[0]?.n ?? 0;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${ADMIN}, ${ADMIN}, ${`${ADMIN}@fixture.example`}, true)`;
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${MEMBER}, ${MEMBER}, ${`${MEMBER}@fixture.example`}, true)`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${ADMIN}`}, ${WS}, ${ADMIN}, 'admin')`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${MEMBER}`}, ${WS}, ${MEMBER}, 'member')`;

  // The delivered request: the engine's own start, then its delivered fields, which only a finished run sets.
  await startEngineRequest(db.sql as never, {
    organizationId: WS,
    brandId: BRAND,
    requestId: DELIVERED_REQUEST,
    formatId: "ref_repurpose_fixture",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: "art_repurpose_request_delivered",
  });
  masterArtifactId = (
    await writeArtifact(db.sql, { organizationId: WS, requestId: DELIVERED_REQUEST, stage: "edit", type: "edl", body: edlFixture, createdAt: NOW })
  ).artifactId;
  const deliveredRow = await db.sql<{ state: string }>`select state from engine_requests where id = ${DELIVERED_REQUEST} and organization_id = ${WS}`;
  const deliveredState = JSON.parse(deliveredRow[0]?.state ?? "{}") as Record<string, unknown> & { artifacts: Record<string, string> };
  await db.sql`
    update engine_requests set status = 'delivered', state = ${JSON.stringify({
      ...deliveredState,
      status: "delivered",
      manifestId: "mf_repurpose_fixture",
      masterEdlId: edlFixture.edlId,
      artifacts: { ...deliveredState.artifacts, [`edl:${edlFixture.edlId}`]: masterArtifactId },
    })}
    where id = ${DELIVERED_REQUEST} and organization_id = ${WS}
  `;
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id)
    values (${DELIVERED_SESSION}, ${WS}, ${BRAND}, ${ADMIN}, 'Delivered reel', 'started', ${DELIVERED_REQUEST})
  `;

  // A request that has not been delivered: its session cannot be repurposed.
  await startEngineRequest(db.sql as never, {
    organizationId: WS,
    brandId: BRAND,
    requestId: UNDELIVERED_REQUEST,
    formatId: "ref_repurpose_undelivered",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: "art_repurpose_request_undelivered",
  });
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id)
    values (${UNDELIVERED_SESSION}, ${WS}, ${BRAND}, ${ADMIN}, 'Still rendering', 'started', ${UNDELIVERED_REQUEST})
  `;
});

after(async () => {
  await db.close();
});

describe("previewing a repurpose", () => {
  test("resolves the variations on the delivered master, and names the master", async () => {
    const preview = await repurposePreview(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(3) });
    assert.equal(preview.status, "resolved");
    assert.equal(preview.masterEdlId, edlFixture.edlId);
    if (preview.status === "resolved") assert.equal(preview.variations.length, 3);
  });

  test("refuses a session whose video is not delivered yet", async () => {
    await assert.rejects(repurposePreview(db.sql, ADMIN, { sessionId: UNDELIVERED_SESSION, settings: settings(2) }), /not delivered yet/);
  });

  test("refuses a member who is not an admin", async () => {
    await assert.rejects(repurposePreview(db.sql, MEMBER, { sessionId: DELIVERED_SESSION, settings: settings(2) }), /admin/i);
  });
});

describe("starting a repurpose, with no verified render price", () => {
  test("plans every variation as a child cut under the master's request, and renders none", async () => {
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(3) });
    assert.equal(run.created, true);
    assert.equal(run.variations.length, 3);
    for (const variation of run.variations) {
      assert.equal(variation.status, "not_priced", "no variation is rendered without a verified price");
      assert.equal(variation.reason, RENDER_PRICE_NOT_VERIFIED);
      assert.equal(variation.renderedArtifactId, null);
    }
    assert.equal(await childArtifactCount(), 3, "each child cut is stored once, under the master's request");
    const parents = await db.sql<{ parent_ids: string }>`
      select parent_ids from engine_artifacts where request_id = ${DELIVERED_REQUEST} and type = 'edl' and stage = 'repurpose'
    `;
    for (const parent of parents) assert.deepEqual(JSON.parse(parent.parent_ids), [masterArtifactId], "each child names the master as its parent");
  });

  test("a repeated start with the same settings returns the same run and plans nothing twice", async () => {
    const first = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(3) });
    const again = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(3) });
    assert.equal(again.created, false);
    assert.equal(again.runId, first.runId);
    assert.equal(again.variations.length, 3);
    assert.equal(await childArtifactCount(), 3, "no second child cut is stored");
  });

  test("a start with settings that are off is refused, and nothing is planned", async () => {
    await assert.rejects(startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: { ...settings(2), enabled: false } }), /Turn repurposing on/);
  });

  test("a start on a session whose video is not delivered is refused, and nothing is planned", async () => {
    await assert.rejects(startRepurpose(db.sql, ADMIN, { sessionId: UNDELIVERED_SESSION, settings: settings(2) }), /not delivered yet/);
    const rows = await db.sql<{ n: number }>`select count(*)::int as n from content_factory_repurpose_runs where session_id = ${UNDELIVERED_SESSION}`;
    assert.equal(rows[0]?.n ?? 0, 0);
  });
});

describe("with a price and a renderer injected (not a live render)", () => {
  test("a priced variation with no renderer is recorded as not connected, not as rendered", async () => {
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(2) }, { renderPriceUsd: () => 0.2 });
    for (const variation of run.variations) {
      assert.equal(variation.status, "not_connected");
      assert.equal(variation.reason, RENDERER_NOT_CONNECTED);
    }
  });

  test("the renderer's result is recorded per variation, and a rendered variation is never rendered again", async () => {
    const renderedKeys: string[] = [];
    let attempts = 0;
    const ports = {
      renderPriceUsd: () => 0.2,
      render: async (child: { variationKey: string; estimateUsd: number }) => {
        attempts += 1;
        renderedKeys.push(child.variationKey);
        assert.equal(child.estimateUsd, 0.2);
        if (attempts === 2) return { status: "failed" as const, reason: "the cloud renderer returned an error for this cut" };
        return { status: "rendered" as const, artifactId: `art_rendered_${attempts}` };
      },
    };
    const first = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(3) }, ports);
    const statuses = first.variations.map((variation) => variation.status);
    assert.deepEqual(statuses.sort(), ["failed", "rendered", "rendered"].sort());
    const rendered = first.variations.filter((variation) => variation.status === "rendered");
    for (const variation of rendered) assert.match(variation.renderedArtifactId ?? "", /^art_rendered_/);
    assert.equal(attempts, 3);

    // A second start retries only the failed variation; the rendered ones are not sent again.
    const second = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(3) }, ports);
    assert.equal(second.created, false);
    assert.equal(attempts, 4, "exactly one retry: the failed variation");
    assert.equal(second.variations.filter((variation) => variation.status === "rendered").length, 3);
    assert.equal(renderedKeys.length, 4);
  });

  test("a variation claimed for rendering is not sent again, and its status is not overwritten", async () => {
    // A third run on new settings, with one variation left in 'rendering' as an interrupted call would leave it.
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(2) }, { renderPriceUsd: () => 0.2 });
    const claimed = run.variations[0]!;
    await db.sql`update content_factory_repurpose_variants set status = 'rendering' where run_id = ${run.runId} and variant_key = ${claimed.key}`;
    let sent = 0;
    const ports = {
      renderPriceUsd: () => 0.2,
      render: async () => {
        sent += 1;
        return { status: "rendered" as const, artifactId: "art_should_not_happen" };
      },
    };
    const again = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(2) }, ports);
    assert.equal(again.runId, run.runId);
    assert.equal(sent, 1, "only the variation not claimed is sent");
    const after = again.variations.find((variation) => variation.key === claimed.key);
    assert.equal(after?.status, "rendering", "the interrupted variation keeps its status and is not sent again");
    assert.equal(after?.renderedArtifactId, null);
  });

  test("two starts at the same time send each variation to the renderer once", async () => {
    const sentKeys: string[] = [];
    const ports = {
      renderPriceUsd: () => 0.2,
      render: async (child: { variationKey: string }) => {
        sentKeys.push(child.variationKey);
        // A slow call, so the second start runs while the first is still rendering.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { status: "rendered" as const, artifactId: `art_concurrent_${sentKeys.length}` };
      },
    };
    const [first, second] = await Promise.all([
      startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(4) }, ports),
      startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(4) }, ports),
    ]);
    assert.equal(first.runId, second.runId, "both starts are the same run");
    assert.equal(new Set(sentKeys).size, sentKeys.length, "no variation is sent twice");
    assert.equal(sentKeys.length, 4, "each of the four variations is sent once");
    const rendered = await db.sql<{ n: number }>`
      select count(*)::int as n from content_factory_repurpose_variants where run_id = ${first.runId} and status = 'rendered'
    `;
    assert.equal(rendered[0]?.n, 4);
  });
});

describe("opening a rendered variation's video", () => {
  /** Attaches a stored rendered video to one rendered variation of the run, as the render port would have recorded it. */
  async function renderedVariation(number: number) {
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(3) });
    const rendered = run.variations.find((variation) => variation.status === "rendered");
    assert.ok(rendered, "the run has a rendered variation");
    const videoId = `vid_01HZ${String(number).padStart(22, "0")}`;
    const video = await writeArtifact(db.sql, {
      organizationId: WS,
      requestId: DELIVERED_REQUEST,
      stage: "render",
      type: "rendered_video",
      body: {
        videoId,
        edlId: rendered.childEdlId,
        uri: `store://renders/${videoId}.mp4`,
        renderer: "hyperframes-cloud",
        durationMs: edlFixture.durationMs,
        bytes: 16,
        estimateUsd: 0.05,
        costUsd: null,
        idempotencyKey: `sha256:${"a".repeat(64)}`,
      },
      createdAt: NOW,
    });
    await db.sql`update content_factory_repurpose_variants set rendered_artifact_id = ${video.artifactId} where run_id = ${run.runId} and variant_key = ${rendered.key}`;
    return { runId: run.runId, variantKey: rendered.key, videoId };
  }

  test("signs a 15-minute link to the stored video, and only for a variation recorded as rendered", async () => {
    const { runId, variantKey, videoId } = await renderedVariation(1);
    const calls: Array<{ organizationId: string; key: string; ttlSeconds: number }> = [];
    const signer = {
      sign: async (organizationId: string, key: string, ttlSeconds: number) => {
        calls.push({ organizationId, key, ttlSeconds });
        return { status: "ok" as const, url: `https://app.example.test/api/engine-media?key=${key}`, expires: 1 };
      },
    };
    const link = await repurposeOutputLink(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId, variantKey }, signer);
    assert.equal(link.status, "ok");
    assert.deepEqual(calls, [{ organizationId: WS, key: `renders/${videoId}.mp4`, ttlSeconds: 900 }], "the stored key, the organization, and 15 minutes");
  });

  test("refuses a variation with no rendered video, and signs nothing", async () => {
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(3) });
    let signed = 0;
    const signer = { sign: async () => { signed += 1; return { status: "ok" as const, url: "https://x.test", expires: 1 }; } };
    const link = await repurposeOutputLink(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId: run.runId, variantKey: "no-such-variation" }, signer);
    assert.equal(link.status, "refused");
    assert.equal(signed, 0);
  });

  test("refuses a member who is not an admin", async () => {
    const { runId, variantKey } = await renderedVariation(2);
    await assert.rejects(repurposeOutputLink(db.sql, MEMBER, { sessionId: DELIVERED_SESSION, runId, variantKey }), /admin/i);
  });

  test("says not connected when the engine's signing secret is not set, rather than returning a link", async () => {
    const { runId, variantKey } = await renderedVariation(3);
    const signer = { sign: async () => ({ status: "not_connected" as const, reason: "the media link secret is not set" }) };
    const link = await repurposeOutputLink(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId, variantKey }, signer);
    assert.equal(link.status, "not_connected");
  });
});

describe("reviewing a rendered repurposed variation", () => {
  /** A stored rendered video on one rendered variation, so the review has a video to decide on. */
  async function reviewable(number: number) {
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(3) });
    const rendered = run.variations.find((variation) => variation.status === "rendered");
    assert.ok(rendered, "the run has a rendered variation");
    const videoId = `vid_01HZ${String(100 + number).padStart(22, "0")}`;
    const video = await writeArtifact(db.sql, {
      organizationId: WS,
      requestId: DELIVERED_REQUEST,
      stage: "render",
      type: "rendered_video",
      body: {
        videoId,
        edlId: rendered.childEdlId,
        uri: `store://renders/${videoId}.mp4`,
        renderer: "hyperframes-cloud",
        durationMs: edlFixture.durationMs,
        bytes: 16,
        estimateUsd: 0.05,
        costUsd: null,
        idempotencyKey: `sha256:${"b".repeat(64)}`,
      },
      createdAt: NOW,
    });
    await db.sql`update content_factory_repurpose_variants set rendered_artifact_id = ${video.artifactId} where run_id = ${run.runId} and variant_key = ${rendered.key}`;
    return { runId: run.runId, variantKey: rendered.key, artifactId: video.artifactId };
  }

  test("an approval is recorded on the rendered video it was made on, and shows in the review state", async () => {
    const { runId, variantKey } = await reviewable(1);
    await recordRepurposeReview(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId, variantKey, decision: "approved", reason: "Looks right." });
    const states = await repurposeReviewsOf(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId });
    assert.equal(states[variantKey]?.status, "approved");
    assert.equal(states[variantKey]?.reason, "Looks right.");
  });

  test("a second approval of the same video is refused, as it is for a master", async () => {
    const { runId, variantKey } = await reviewable(2);
    await recordRepurposeReview(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId, variantKey, decision: "approved", reason: "" });
    await assert.rejects(recordRepurposeReview(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId, variantKey, decision: "approved", reason: "" }), /already approved/);
  });

  test("a rejection needs a reason of at least 10 characters, and is recorded with it", async () => {
    const { runId, variantKey } = await reviewable(3);
    await assert.rejects(recordRepurposeReview(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId, variantKey, decision: "rejected", reason: "no" }), /at least 10 characters/);
    await recordRepurposeReview(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId, variantKey, decision: "rejected", reason: "The product is not visible." });
    const states = await repurposeReviewsOf(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId });
    assert.equal(states[variantKey]?.status, "rejected");
  });

  test("a variation that was not rendered cannot be reviewed", async () => {
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, settings: settings(2) }, { renderPriceUsd: () => 0.2 });
    await assert.rejects(
      recordRepurposeReview(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId: run.runId, variantKey: run.variations[0]!.key, decision: "approved", reason: "" }),
      /not rendered/,
    );
  });

  test("a member who is not an admin cannot review, and reads no review state", async () => {
    const { runId, variantKey } = await reviewable(4);
    await assert.rejects(recordRepurposeReview(db.sql, MEMBER, { sessionId: DELIVERED_SESSION, runId, variantKey, decision: "approved", reason: "" }), /admin/i);
    await assert.rejects(repurposeReviewsOf(db.sql, MEMBER, { sessionId: DELIVERED_SESSION, runId }), /admin/i);
  });

  test("a re-rendered video starts undecided: the earlier decision was on a different video", async () => {
    const { runId, variantKey } = await reviewable(5);
    await recordRepurposeReview(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId, variantKey, decision: "approved", reason: "" });
    const newVideo = await writeArtifact(db.sql, {
      organizationId: WS,
      requestId: DELIVERED_REQUEST,
      stage: "render",
      type: "rendered_video",
      body: {
        videoId: `vid_01HZ${String(105).padStart(22, "0")}`,
        edlId: edlFixture.edlId,
        uri: `store://renders/vid_01HZ${String(105).padStart(22, "0")}.mp4`,
        renderer: "hyperframes-cloud",
        durationMs: edlFixture.durationMs,
        bytes: 16,
        estimateUsd: 0.05,
        costUsd: null,
        idempotencyKey: `sha256:${"c".repeat(64)}`,
      },
      createdAt: NOW,
    });
    await db.sql`update content_factory_repurpose_variants set rendered_artifact_id = ${newVideo.artifactId} where run_id = ${runId} and variant_key = ${variantKey}`;
    const states = await repurposeReviewsOf(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId });
    assert.equal(states[variantKey]?.status, "not_decided");
  });
});


describe("recording a Meta upload receipt in Postgres", () => {
  test("a receipt is stored once per variation and account, is found again by both, and a second receipt for the same pair is refused", async () => {
    const rows = await db.sql<{ id: string }>`select v.id from content_factory_repurpose_variants v where v.rendered_artifact_id is not null limit 1`;
    const variantId = rows[0]!.id;
    const store = sqlRepurposeUploadStore(db.sql);
    assert.equal(await store.find(variantId, "act_fixture_1"), null);

    const receipt = {
      id: "upl_fixture_1",
      organizationId: WS,
      brandId: BRAND,
      variantId,
      platformAccountId: "act_fixture_1",
      externalId: "meta_video_fixture_1",
      idempotencyKey: `${BRAND}:run:variation:act_fixture_1:meta_ad_video`,
    };
    await store.save(receipt);
    assert.deepEqual(await store.find(variantId, "act_fixture_1"), receipt);
    await assert.rejects(store.save({ ...receipt, id: "upl_fixture_2", idempotencyKey: `${receipt.idempotencyKey}:again` }));
    assert.equal(await store.find(variantId, "act_fixture_2"), null, "another account has no receipt");
  });
});

describe("uploading a repurposed variation to Meta, from the session", () => {
  test("a member is refused, and an admin's request for a variation the gate refuses sends nothing to Meta", async () => {
    const rows = await db.sql<{ run_id: string; variant_key: string }>`
      select v.run_id, v.variant_key from content_factory_repurpose_variants v
      join content_factory_repurpose_runs r on r.id = v.run_id
      where v.rendered_artifact_id is not null and r.session_id = ${DELIVERED_SESSION}
      limit 1
    `;
    const { run_id: runId, variant_key: variantKey } = rows[0]!;
    const noSend = async () => {
      throw new Error("nothing may be sent to Meta in this test");
    };
    await assert.rejects(
      uploadRepurposeVariantToMeta(db.sql, MEMBER, { sessionId: DELIVERED_SESSION, runId, variantKey }, { env: {}, transport: noSend }),
    );
    const outcome = await uploadRepurposeVariantToMeta(db.sql, ADMIN, { sessionId: DELIVERED_SESSION, runId, variantKey }, { env: {}, transport: noSend });
    assert.equal(outcome.status, "blocked");
  });
});
