import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routes, type RouteTable } from "../config/routes.ts";
import { assetCacheKey, type AssetSpec } from "../contracts/assets.ts";
import { ledgerWithReservation, fixture, gatewayFor, json, routesWith, scripted } from "./test/recorded.ts";
import { FRAME_TEST_PROMPT, frameTestFromListing, pinnedCandidate, renderFrameTable, runFirstLastFrameTest, videoRoutesForFrameTest } from "./firstLastFrame.ts";
import { videoProfilesFromListing } from "./providers/openrouterVideo.ts";
import { INITIAL_DISABLED_MODEL_FAMILIES } from "../config/model-policy.ts";
import { EngineError } from "../contracts/errors.ts";

const KLING = "kwaivgi/kling-v3.0-std";
const SEED = "bytedance/seedance-2.0";
const WAN = "alibaba/wan-2.6";

/** The family of a model: its vendor prefix, which is how the policy names a family (config/model-policy.ts). */
const familyOf = (model: string): string => `${model.split("/")[0] ?? model}/`;

const target = (model: string, priceKey: "kling_v3_standard" | "seedance_2_5" | "wan_2_6") => ({
  provider: "openrouter",
  model,
  priceKey,
  verified: false,
});

/** The candidates the test covers: Kling and Seedance in the cinematic class, Wan in the budget class. */
const TABLE: RouteTable = {
  ...routesWith(
    "video.cinematic",
    [target(KLING, "kling_v3_standard"), target(SEED, "seedance_2_5")],
    routes.table,
  ),
  "video.budget": { targets: [target(WAN, "wan_2_6")] },
};

const FRAMES = { first: "https://assets.example.com/first.jpg", last: "https://assets.example.com/last.jpg" };

describe("first-and-last-frame table from the listing", () => {
  it("passes only the models whose listing shows both frames, durations and the 1080p portrait output", () => {
    const gateway = gatewayFor(scripted({}).transport, { routes: TABLE });
    const rows = frameTestFromListing(fixture("video-models.json"), videoRoutesForFrameTest(gateway), 5, INITIAL_DISABLED_MODEL_FAMILIES);
    const byModel = new Map(rows.map((row) => [row.model, row]));

    assert.equal(byModel.get(KLING)?.pass, true);
    assert.equal(byModel.get(SEED)?.pass, false, "no frames in the listing");
    assert.equal(byModel.get(WAN)?.pass, false, "first frame only");
    assert.equal(byModel.get(WAN)?.lastFrame, false);
    assert.equal(rows.every((row) => row.basis === "listing_only"), true, "no call was made");
  });

  it("does not pin a model from the listing alone, and pins the first passing model when a live submit confirms it", () => {
    const gateway = gatewayFor(scripted({}).transport, { routes: TABLE });
    const rows = frameTestFromListing(fixture("video-models.json"), videoRoutesForFrameTest(gateway), 5, INITIAL_DISABLED_MODEL_FAMILIES);
    assert.equal(pinnedCandidate(rows, { requireLive: true }), null);
    assert.equal(pinnedCandidate(rows, { requireLive: false }), KLING, "route order: Kling first");
  });

  it("renders a markdown table with one row per model", () => {
    const gateway = gatewayFor(scripted({}).transport, { routes: TABLE });
    const table = renderFrameTable(frameTestFromListing(fixture("video-models.json"), videoRoutesForFrameTest(gateway), 5, INITIAL_DISABLED_MODEL_FAMILIES));
    const lines = table.split("\n");
    assert.equal(lines.length, 2 + 3);
    assert.match(lines[0] ?? "", /^\| model \| class \|/);
    assert.match(lines[2] ?? "", new RegExp(`^\\| ${KLING.replace(".", "\\.")} \\|`));
  });

  it("lists each model once, with the cinematic route first", () => {
    const gateway = gatewayFor(scripted({}).transport, { routes: TABLE });
    assert.deepEqual(
      videoRoutesForFrameTest(gateway).map((route) => route.model),
      [KLING, SEED, WAN],
    );
  });

  it("the listing's rejected entries are reported, not guessed at", () => {
    const parsed = videoProfilesFromListing(fixture("video-models.json"));
    assert.deepEqual(parsed.rejected.map((entry) => entry.id), ["broken/entry"]);
  });
});

describe("first-and-last-frame live run", () => {
  it("submits one test per model whose listing shows both frames, records the accepted one, and pins it", async () => {
    const script = scripted({
      "GET /api/v1/videos/models": json(200, fixture("video-models.json")),
      "POST /api/v1/videos": json(200, { id: "job-kling", status: "pending" }),
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
      disabledFamilies: INITIAL_DISABLED_MODEL_FAMILIES,
    });

    const byModel = new Map(run.rows.map((row) => [row.model, row]));
    assert.equal(byModel.get(KLING)?.submit.kind, "accepted");
    assert.equal(byModel.get(KLING)?.pass, true);
    assert.equal(byModel.get(SEED)?.submit.kind, "not_run");
    assert.equal(byModel.get(WAN)?.submit.kind, "not_run");
    assert.equal(run.pinned, KLING);

    // GET models, then one POST for each model whose listing shows both frames, and none for the others.
    assert.equal(script.requests.length, 2);
    assert.equal(script.requests[0]?.url, "https://openrouter.ai/api/v1/videos/models");
    const submitted = script.requests.slice(1).map((request) => JSON.parse(String(request.body)).model);
    assert.deepEqual(submitted, [KLING]);

    const klingBody = JSON.parse(String(script.requests[1]?.body));
    assert.equal(klingBody.frame_images.length, 2);
    assert.equal(klingBody.duration, 5);
  });

  it("records a rejected submit as rejected, and pins nothing", async () => {
    const script = scripted({
      "GET /api/v1/videos/models": json(200, fixture("video-models.json")),
      "POST /api/v1/videos": json(400, fixture("video-400-unsupported.json")),
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
      disabledFamilies: INITIAL_DISABLED_MODEL_FAMILIES,
    });

    const kling = run.rows.find((row) => row.model === KLING);
    assert.equal(kling?.submit.kind, "rejected");
    assert.equal(kling?.pass, false);
    assert.equal(run.pinned, null, "a rejected test pins nothing");
    assert.deepEqual(script.requests.slice(1).map((request) => JSON.parse(String(request.body)).model), [KLING]);
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
      disabledFamilies: INITIAL_DISABLED_MODEL_FAMILIES,
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

describe("first-and-last-frame test with a model of a switched-off family (owner direction 2026-10-23)", () => {
  // Veo 3.1 is first in the cinematic class and its listing shows both frames, 5 s and 1080p, so only the policy keeps it out.
  const VEO = "google/veo-3.1";
  const WITH_VEO: RouteTable = {
    ...routesWith("video.cinematic", [target(VEO, "kling_v3_standard"), target(KLING, "kling_v3_standard")], routes.table),
    "video.budget": { targets: [target(WAN, "wan_2_6")] },
  };

  it("the table does not pass Veo under the initial policy, so the first passing model is Kling", () => {
    const gateway = gatewayFor(scripted({}).transport, { routes: WITH_VEO });
    const rows = frameTestFromListing(fixture("video-models.json"), videoRoutesForFrameTest(gateway), 5, INITIAL_DISABLED_MODEL_FAMILIES);
    const veo = rows.find((row) => row.model === VEO);
    assert.equal(veo?.listed, true, "the listing names Veo");
    assert.equal(veo?.pass, false, "its listing would pass, but its family is switched off");
    assert.equal(veo?.submit.kind, "not_run");
    assert.equal(pinnedCandidate(rows, { requireLive: false }), KLING);
  });

  it("the live run does not submit Veo, and pins Kling when Kling is accepted", async () => {
    const script = scripted({
      "GET /api/v1/videos/models": json(200, fixture("video-models.json")),
      "POST /api/v1/videos": json(200, { id: "job-kling", status: "pending" }),
    });
    const gateway = gatewayFor(script.transport, { routes: WITH_VEO });
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
      disabledFamilies: INITIAL_DISABLED_MODEL_FAMILIES,
    });

    const veo = run.rows.find((row) => row.model === VEO);
    assert.equal(veo?.submit.kind, "not_run");
    assert.equal(veo?.pass, false);
    assert.equal(run.pinned, KLING);
    assert.deepEqual(script.requests.slice(1).map((request) => JSON.parse(String(request.body)).model), [KLING], "no request names Veo");
  });

  it("an explicit list of switched-off families replaces the initial one: Kling is not submitted, and Veo is", async () => {
    const script = scripted({
      "GET /api/v1/videos/models": json(200, fixture("video-models.json")),
      "POST /api/v1/videos": json(200, { id: "job-veo", status: "pending" }),
    });
    const gateway = gatewayFor(script.transport, { routes: WITH_VEO });
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
      disabledFamilies: ["kwaivgi/"],
    });

    assert.equal(run.rows.find((row) => row.model === KLING)?.submit.kind, "not_run");
    assert.equal(run.rows.find((row) => row.model === VEO)?.submit.kind, "accepted");
    assert.deepEqual(script.requests.slice(1).map((request) => JSON.parse(String(request.body)).model), [VEO]);
  });
});

describe("the workspace's switched-off families are required, and are the ones applied (D16)", () => {
  it("a live run that passes no families is refused before the listing is read, so nothing is sent", async () => {
    const script = scripted({
      "GET /api/v1/videos/models": json(200, fixture("video-models.json")),
      "POST /api/v1/videos": json(200, { id: "job-first", status: "pending" }),
    });
    const gateway = gatewayFor(script.transport, { routes: TABLE });
    const { ledger, reservationId } = await ledgerWithReservation(5);

    const withoutFamilies = { gateway, organizationId: "org_1", workspaceId: "org_1", ledger, reservationId, frames: FRAMES, durationSeconds: 5, at: "2026-10-14T10:00:00.000Z" };
    await assert.rejects(runFirstLastFrameTest(withoutFamilies as never), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    assert.equal(script.requests.length, 0, "the listing is not read and nothing is submitted");
  });

  it("the table refuses to decide a route when no families are passed", () => {
    const gateway = gatewayFor(scripted({}).transport, { routes: TABLE });
    assert.throws(
      () => frameTestFromListing(fixture("video-models.json"), videoRoutesForFrameTest(gateway), 5, undefined as never),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });

  it("a family the workspace switched off, which the built-in list does not name, is not submitted, and its row says why", async () => {
    const script = scripted({
      "GET /api/v1/videos/models": json(200, fixture("video-models.json")),
      "POST /api/v1/videos": json(200, { id: "job-first", status: "pending" }),
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
      disabledFamilies: [...INITIAL_DISABLED_MODEL_FAMILIES, familyOf(KLING)],
    });

    const kling = run.rows.find((row) => row.model === KLING);
    assert.equal(kling?.pass, false);
    assert.equal(kling?.submit.kind, "not_run");
    assert.match(JSON.stringify(kling?.submit), /switched off by the workspace's model policy/);
    assert.equal(run.pinned, null, "nothing passes, so nothing is pinned");
    assert.equal(script.requests.length, 1, "only the listing was read: no request names the switched-off family");
  });
});
