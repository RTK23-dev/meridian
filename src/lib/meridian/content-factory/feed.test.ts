// The decision feed, mapped from what the engine recorded. The request is the contract fixtures' request (src/engine/contracts/fixtures),
// run through the operations chain world with recorded providers (src/engine/ops/test/chain.ts), then read through the engine's API
// (engineRequestFeed). The other cases change one recorded value at a time: no bill, a pause, a rejection, a recorded model choice.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { engineRequestFeed, type EngineRequestFeed } from "../../../engine/api/index.ts";
import { chainWorld, drain, startChainRequest } from "../../../engine/ops/test/chain.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { CARD_IDS, costLabel, costOf, feedCards, type FeedCard } from "./feed.ts";

const WS = "ws_cf_feed";
const BRAND = "brand_cf_feed";

function card(cards: FeedCard[], id: FeedCard["id"]): FeedCard {
  const found = cards.find((item) => item.id === id);
  assert.ok(found, `card ${id}`);
  return found;
}

describe("Content Factory decision feed", () => {
  let db: TestDatabase;
  let recorded: EngineRequestFeed;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
    const world = await chainWorld(db.sql, WS);
    const started = await startChainRequest(world, { slot: 1, brandId: BRAND, formatId: "fmt_cf_feed", priority: "normal", variantCount: 0 });
    await drain(db.sql, world.runtime, WS);
    const feed = await engineRequestFeed(db.sql, WS, started.requestId);
    assert.ok(feed);
    recorded = feed;
  });

  after(async () => {
    await db.close();
  });

  test("a delivered run shows one card per step, in the engine's order, each done", () => {
    const run = feedCards(recorded);
    assert.deepEqual(run.cards.map((item) => item.id), [...CARD_IDS]);
    assert.equal(run.active, false, "a delivered run is not polled");
    assert.equal(run.headline, "The engine delivered the video.");
    for (const item of run.cards) assert.equal(item.status, "done", `${item.id}: ${item.statusText}`);
    assert.match(card(run.cards, "reference_analysis").statusText, /reused its stored analysis/);
  });

  test("each card carries its inputs, its output and its reasons from the engine's records", () => {
    const run = feedCards(recorded);
    const script = card(run.cards, "script");
    assert.ok(script.output.some((line) => line.startsWith("hook: ")), script.output.join(" | "));
    const plan = card(run.cards, "plan");
    assert.ok(plan.output.some((line) => /shots, estimated at \$/.test(line)));
    assert.ok(plan.reasons.length > 0, "the plan's decisions are shown with their reasons");
    const visuals = card(run.cards, "visuals");
    assert.ok(visuals.reasons.some((line) => line.includes("slop.hands")), "the failed take check is shown with its rule");
    const reference = card(run.cards, "reference_analysis");
    assert.ok(reference.output.some((line) => /source media/.test(line)), "the feed says whether the source media was deleted");
    const render = card(run.cards, "render");
    assert.ok(render.output.some((line) => line.startsWith("Render estimate")));
  });

  test("a model is the route the shot is sent on until the shot records its choice, and says so", () => {
    const run = feedCards(recorded);
    const models = card(run.cards, "model_choices");
    assert.ok(models.models.some((model) => model.basis === "route"), "contract v6 plans have no modelChoice");
    assert.ok(models.models.every((model) => model.basis !== "chosen"));
    assert.ok(models.models.some((model) => model.basis === "used"), "the takes name the model that made them");
    assert.equal(models.cost, null);
    assert.ok(models.costNote);

    const withChoice = structuredClone(recorded);
    const plan = withChoice.artifacts.find((artifact) => artifact.type === "scene_plan");
    assert.ok(plan && plan.type === "scene_plan");
    const shot = plan.shots.find((item) => item.modelClasses.length > 0);
    assert.ok(shot);
    shot.modelChoice = { model: "kwaivgi/kling-v3.0-std", provider: "openrouter", reason: "fits 9:16 and the shot length", catalogReadAt: "2026-10-16T10:00:00.000Z" };
    const chosen = card(feedCards(withChoice).cards, "model_choices");
    assert.ok(chosen.models.some((model) => model.basis === "chosen" && model.model === "kwaivgi/kling-v3.0-std"));
    assert.ok(chosen.reasons.some((line) => line.includes("fits 9:16")));
  });

  test("costs are the ledger's: estimate, reserved and billed, and a step with no bill shows unknown", () => {
    const run = feedCards(recorded);
    const render = card(run.cards, "render");
    assert.ok(render.cost);
    assert.equal(render.cost.calls, 1);
    assert.equal(render.cost.estimateUsd, 0.05);
    assert.equal(render.cost.billedUsd, 0.05, "the recorded render bill");
    assert.equal(run.unattributedCalls, 1, "the Critic's role call is on the ledger with no step of its own");

    const voice = card(run.cards, "voice");
    assert.ok(voice.cost);
    assert.equal(voice.cost.calls, 0);
    assert.equal(costLabel(voice.cost.billedUsd), "unknown", "no ledger row is not a bill of $0");
    assert.equal(costLabel(voice.cost.estimateUsd), "unknown");

    const unbilled = structuredClone(recorded);
    for (const row of unbilled.ledger) {
      if (row.stage === "render") {
        row.actualUsd = null;
        row.settlement = null;
      }
    }
    const unbilledRender = card(feedCards(unbilled).cards, "render");
    assert.equal(unbilledRender.cost?.billedUsd, null);
    assert.equal(unbilledRender.cost?.unsettled, 1);
    assert.equal(unbilledRender.cost?.reservedUsd, 0.05, "the hold is still shown");
    assert.deepEqual(costOf([]), { calls: 0, unsettled: 0, estimateUsd: null, reservedUsd: null, billedUsd: null });
  });

  test("a paused run marks the step it paused at, keeps polling off, and says why", () => {
    const paused = structuredClone(recorded);
    paused.status = { status: "paused", requestId: paused.requestId, pauseKind: "budget", stage: "estimate_reserve", reason: "the workspace monthly video budget is not set" };
    paused.pause = { kind: "budget", stage: "estimate_reserve", reason: "the workspace monthly video budget is not set" };
    const run = feedCards(paused);
    const plan = card(run.cards, "plan");
    assert.equal(plan.status, "paused");
    assert.match(plan.statusText, /monthly video budget/);
    assert.equal(run.active, false);
  });

  test("a request refused at intake fails the script card with the engine's reasons, and later steps have not started", () => {
    const refused = structuredClone(recorded);
    refused.status = { status: "failed", requestId: refused.requestId, reasons: ["claims: claim_x is not approved"] };
    refused.nodes = { ...refused.nodes, intake: "idle", voice: "idle", plan: "idle", estimate_reserve: "idle", edit: "idle", deliver: "idle", analyze_reference: "idle" };
    refused.artifacts = refused.artifacts.filter((artifact) => artifact.type === "production_request");
    refused.branches = [];
    refused.jobs = {};
    const run = feedCards(refused);
    const script = card(run.cards, "script");
    assert.equal(script.status, "failed");
    assert.ok(script.reasons.includes("claims: claim_x is not approved"));
    assert.equal(card(run.cards, "voice").status, "not_started");
    assert.equal(card(run.cards, "delivery").status, "not_started");
  });

  test("a running step shows as running while its job runs, and the run is polled", () => {
    const running = structuredClone(recorded);
    running.status = { status: "running", requestId: running.requestId, stage: "render" };
    running.branches = running.branches.map((branch) => ({ ...branch, stage: "render", status: "running" }));
    running.nodes = { ...running.nodes, deliver: "idle" };
    running.jobs = { ...running.jobs, render: { queued: 0, running: 1, retry: 0, succeeded: 0, dead: 0 } };
    const run = feedCards(running);
    assert.equal(run.active, true);
    assert.equal(card(run.cards, "render").status, "running");
    assert.equal(card(run.cards, "delivery").status, "not_started");
  });
});
