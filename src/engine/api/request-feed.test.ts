// engineRequestFeed (the read behind the Content Factory decision feed), on PGlite or PostgreSQL with no provider call. The request runs
// through the operations chain world: its upstream stages are answered from the contract fixtures, and compose, render, review and deliver
// run through the real handlers with recorded providers (src/engine/ops/test/chain.ts).

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chainWorld, drain, startChainRequest } from "../ops/test/chain.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { engineRequestFeed, type EngineRequestFeed } from "./index.ts";

const WS = "ws_feed_a";
const OTHER_WS = "ws_feed_b";
const BRAND = "brand_feed_a";

describe("engineRequestFeed", () => {
  let db: TestDatabase;
  let requestId: string;
  let feed: EngineRequestFeed;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
    await seedWorkspace(db.sql, OTHER_WS);
    const world = await chainWorld(db.sql, WS);
    const started = await startChainRequest(world, { slot: 1, brandId: BRAND, formatId: "fmt_feed", priority: "normal", variantCount: 0 });
    requestId = started.requestId;
    await drain(db.sql, world.runtime, WS);
    const read = await engineRequestFeed(db.sql, WS, requestId);
    assert.ok(read);
    feed = read;
  });

  after(async () => {
    await db.close();
  });

  test("a delivered request reads back its status, nodes, branches and jobs", () => {
    assert.equal(feed.status.status, "delivered");
    assert.equal(feed.cachedDna, true, "the chain world hands over a cached VideoDNA");
    assert.equal(feed.nodes.deliver, "passed");
    assert.equal(feed.nodes.voice, "passed");
    assert.ok(feed.branches.some((branch) => branch.variantOf === null && branch.stage === "done"));
    assert.ok((feed.jobs.render?.succeeded ?? 0) >= 1, "the render job is counted");
    assert.equal(feed.pause, null);
  });

  test("artifacts are read through their contracts and summarised, in the order they were stored", () => {
    const types = feed.artifacts.map((artifact) => artifact.type);
    for (const type of ["production_request", "video_dna", "voice_track", "scene_plan", "take", "take_verdict", "edl", "rendered_video", "manifest"]) {
      assert.ok(types.includes(type as never), `${type} is in the feed`);
    }
    const request = feed.artifacts.find((artifact) => artifact.type === "production_request");
    assert.ok(request && request.type === "production_request");
    assert.ok(request.beats.length > 0);
    const plan = feed.artifacts.find((artifact) => artifact.type === "scene_plan");
    assert.ok(plan && plan.type === "scene_plan");
    assert.ok(plan.shots.length > 0);
    for (const shot of plan.shots) {
      assert.equal(shot.modelChoice, null, "contract v6 plans carry no modelChoice, and none is invented");
      if (shot.modelClasses.length > 0) assert.ok(shot.routeTargets.length > 0, "a generated shot names the route it is sent on");
    }
    const video = feed.artifacts.find((artifact) => artifact.type === "rendered_video");
    assert.ok(video && video.type === "rendered_video");
    assert.equal(typeof video.estimateUsd, "number");
  });

  test("gates, decisions and the ledger are read in order, and an unsettled call has no actual cost", () => {
    assert.ok(feed.gates.some((gate) => gate.gate === "post_render" && gate.pass));
    assert.ok(feed.gates.every((gate) => gate.checks.every((check) => typeof check.rule === "string")));
    const plan = feed.artifacts.find((artifact) => artifact.type === "scene_plan");
    assert.ok(plan && plan.type === "scene_plan" && plan.decisions.length > 0, "the plan's own decisions are read with it");
    assert.ok(feed.decisions.every((decision) => decision.reason.length > 0));
    for (const row of feed.ledger) {
      if (row.settlement === null) assert.equal(row.actualUsd, null, "no bill means no actual");
    }
    assert.ok(feed.reservation, "the request's reservation is read");
  });

  test("another workspace reads nothing, and an unknown request is null", async () => {
    assert.equal(await engineRequestFeed(db.sql, OTHER_WS, requestId), null);
    assert.equal(await engineRequestFeed(db.sql, WS, "req_01JZZZZZZZZZZZZZZZZZZZZZZZ"), null);
  });
});
