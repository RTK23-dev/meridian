import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routes, type RouteTable } from "../config/routes.ts";
import { assetCacheKey, type AssetSpec } from "../contracts/assets.ts";
import { ledgerWithReservation, fixture, gatewayFor, json, routesWith, scripted } from "./test/recorded.ts";
import { FRAME_TEST_PROMPT, frameTestFromListing, pinnedCandidate, renderFrameTable, runFirstLastFrameTest, videoRoutesForFrameTest } from "./firstLastFrame.ts";
import { videoProfilesFromListing } from "./providers/openrouterVideo.ts";

const KLING = "kwaivgi/kling-v3.0-std";
const VEO = "google/veo-3.1";
const SEED = "bytedance/seedance-2.0";
const WAN = "alibaba/wan-2.6";

const target = (model: string, priceKey: "kling_v3_standard" | "veo_3_1_fast" | "seedance_2_5" | "wan_3_0") => ({
  provider: "openrouter",
  model,
  priceKey,
  verified: false,
});

/** The candidates the test covers: Kling, Veo and Seedance in the cinematic class, Wan in the budget class. */
const TABLE: RouteTable = {
  ...routesWith(
    "video.cinematic",
    [target(KLING, "kling_v3_standard"), target(VEO, "veo_3_1_fast"), target(SEED, "seedance_2_5")],
    routes.table,
  ),
  "video.budget": { targets: [target(WAN, "wan_3_0")] },
};

const FRAMES = { first: "https://assets.example.com/first.jpg", last: "https://assets.example.com/last.jpg" };

describe("first-and-last-frame table from the listing", () => {
  it("passes only the models whose listing shows both frames, durations and the 1080p portrait output", () => {
    const gateway = gatewayFor(scripted({}).transport, { routes: TABLE });
    const rows = frameTestFromListing(fixture("video-models.json"), videoRoutesForFrameTest(gateway), 5);
    const byModel = new Map(rows.map((row) => [row.model, row]));

    assert.equal(byModel.get(KLING)?.pass, true);
    assert.equal(byModel.get(VEO)?.pass, true);
    assert.equal(byModel.get(SEED)?.pass, false, "no frames in the listing");
    assert.equal(byModel.get(WAN)?.pass, false, "first frame only");
    assert.equal(byModel.get(WAN)?.lastFrame, false);
    assert.equal(rows.every((row) => row.basis === "listing_only"), true, "no call was made");
  });

  it("does not pin a model from the listing alone, and pins the first passing model when a live submit confirms it", () => {
    const gateway = gatewayFor(scripted({}).transport, { routes: TABLE });
    const rows = frameTestFromListing(fixture("video-models.json"), videoRoutesForFrameTest(gateway), 5);
    assert.equal(pinnedCandidate(rows, { requireLive: true }), null);
    assert.equal(pinnedCandidate(rows, { requireLive: false }), KLING, "route order: Kling first");
  });

  it("renders a markdown table with one row per model", () => {
    const gateway = gatewayFor(scripted({}).transport, { routes: TABLE });
    const table = renderFrameTable(frameTestFromListing(fixture("video-models.json"), videoRoutesForFrameTest(gateway), 5));
    const lines = table.split("\n");
    assert.equal(lines.length, 2 + 4);
    assert.match(lines[0] ?? "", /^\| model \| class \|/);
    assert.match(lines[2] ?? "", new RegExp(`^\\| ${KLING.replace(".", "\\.")} \\|`));
  });

  it("lists each model once, with the cinematic route first", () => {
    const gateway = gatewayFor(scripted({}).transport, { routes: TABLE });
    assert.deepEqual(
      videoRoutesForFrameTest(gateway).map((route) => route.model),
      [KLING, VEO, SEED, WAN],
    );
  });

  it("the listing's rejected entries are reported, not guessed at", () => {
    const parsed = videoProfilesFromListing(fixture("video-models.json"));
    assert.deepEqual(parsed.rejected.map((entry) => entry.id), ["broken/entry"]);
  });
});

describe("first-and-last-frame live run", () => {
  it("submits one test per model whose listing shows both frames, records accepted and rejected, and pins the accepted one", async () => {
    const script = scripted({
      "GET /api/v1/videos/models": json(200, fixture("video-models.json")),
      "POST /api/v1/videos": [json(200, { id: "job-kling", status: "pending" }), json(400, fixture("video-400-unsupported.json"))],
    });
    const gateway = gatewayFor(script.transport, { routes: TABLE });
    const { ledger, reservationId } = await ledgerWithReservation(5);

    const run = await runFirstLastFrameTest({
      gateway,
      organizationId: "org_1",
      workspaceId: "org_1",
      ledger,
      reservationId,
      frames: FRAMES,
      durationSeconds: 5,
      at: "2026-10-14T10:00:00.000Z",
    });

    const byModel = new Map(run.rows.map((row) => [row.model, row]));
    assert.equal(byModel.get(KLING)?.submit.kind, "accepted");
    assert.equal(byModel.get(KLING)?.pass, true);
    assert.equal(byModel.get(VEO)?.submit.kind, "rejected");
    assert.equal(byModel.get(VEO)?.pass, false);
    assert.equal(byModel.get(SEED)?.submit.kind, "not_run");
    assert.equal(byModel.get(WAN)?.submit.kind, "not_run");
    assert.equal(run.pinned, KLING);

    // GET models, then one POST for each model whose listing shows both frames, and none for the others.
    assert.equal(script.requests.length, 3);
    assert.equal(script.requests[0]?.url, "https://openrouter.ai/api/v1/videos/models");
    const submitted = script.requests.slice(1).map((request) => JSON.parse(String(request.body)).model);
    assert.deepEqual(submitted, [KLING, VEO]);

    const klingBody = JSON.parse(String(script.requests[1]?.body));
    assert.equal(klingBody.frame_images.length, 2);
    assert.equal(klingBody.duration, 5);
  });

  it("holds each submit on the ledger, keyed by its cache key, and sends nothing when the budget refuses", async () => {
    const script = scripted({
      "GET /api/v1/videos/models": json(200, fixture("video-models.json")),
      "POST /api/v1/videos": json(200, { id: "job-kling", status: "pending" }),
    });
    const gateway = gatewayFor(script.transport, { routes: TABLE });
    const { ledger, reservationId } = await ledgerWithReservation(0.2);

    const run = await runFirstLastFrameTest({
      gateway,
      organizationId: "org_1",
      workspaceId: "org_1",
      ledger,
      reservationId,
      frames: FRAMES,
      durationSeconds: 5,
      at: "2026-10-14T10:00:00.000Z",
    });
    const kling = run.rows.find((row) => row.model === KLING);
    assert.equal(kling?.submit.kind, "refused", "Kling's 0.63 estimate is above the 0.20 reservation in cap mode");
    assert.equal(run.pinned, null);
    assert.equal(script.requests.length, 1, "only the listing was read");
    const spec: AssetSpec = {
      schema: "meridian.asset_spec/v1",
      specId: "asp_01JABCDEFGHJKMNPQRSTVWXYZ0",
      modelChoice: null,
      shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0",
      modelClass: "video.cinematic",
      prompt: FRAME_TEST_PROMPT,
      refs: [],
      firstFrame: FRAMES.first,
      lastFrame: FRAMES.last,
      durationMs: 5000,
      aspect: "9:16",
      width: 1080,
      height: 1920,
      seed: 0,
      takes: 1,
    };
    assert.equal(await ledger.getEntryByKey(assetCacheKey(spec, `openrouter:${KLING}`)), null, "a refused test has no ledger row");
  });
});
