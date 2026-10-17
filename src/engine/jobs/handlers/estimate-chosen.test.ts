// estimate_reserve prices each generation call from its chosen model's catalog price when the request has a model choice (Bible 10.5
// step 5, 14.1 step 1), and from the price table otherwise. Recorded catalog and fixtures only; no live call.

import assert from "node:assert/strict";
import { test } from "node:test";
import { estimatePlan, type ChosenCallPrices, callPriceKey } from "../../budget/estimate.ts";
import { reserveFixed } from "../../budget/preflight.ts";
import { memoryLedgerStore } from "../../budget/store.ts";
import { modelChoicesSchema, type ModelChoices } from "../../contracts/model-choices.ts";
import { FIXTURE_IDS, fixtureId, scenePlanFixture } from "../../contracts/fixtures/index.ts";
import type { ScenePlan } from "../../contracts/index.ts";
import { parseVideoCatalog, type CatalogRead } from "../../gateway/catalog.ts";
import { chosenCallPricesOf } from "../../plan/model-choices.ts";
import { extendForPlan } from "./estimate-reserve.ts";

const REQ = FIXTURE_IDS.request;
const WS = "ws_estimate_chosen";
const HOLD = fixtureId("res_", 812);
const NOW = "2026-10-16T09:00:41.000Z";
const READ_AT = "2026-10-16T09:00:00.000Z";

/**
 * A copy of the scene plan fixture whose generated video shots carry no references: the recorded catalog does not list how many a
 * model takes, so a call with one is refused by the eligibility rule (catalog-fit.ts), which is not what these tests are about.
 */
function planFixture(): ScenePlan {
  const plan = structuredClone(scenePlanFixture) as ScenePlan;
  for (const shot of plan.shots) {
    if (shot.source.kind === "generate") shot.source = { ...shot.source, refs: [] };
  }
  return plan;
}

/** The first generated video shot of the plan (the fixture's first generated shot is an avatar, which the catalog does not list). */
function firstGenerate(plan: ScenePlan) {
  const shot = plan.shots.find((candidate) => candidate.source.kind === "generate" && candidate.source.modelClass.startsWith("video."));
  if (!shot || shot.source.kind !== "generate") throw new Error("the fixture plan has a generated video shot");
  return shot;
}

/** A catalog that lists the recorded video models (unverified live) and one model for the first shot's class at a known rate. */
function catalogOf(extra: Array<{ id: string; usd: number }> = []): CatalogRead {
  const listing = {
    data: [
      ...extra.map((model) => ({
        id: model.id,
        supported_durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        supported_resolutions: ["1080p"],
        supported_aspect_ratios: ["9:16", "16:9"],
        supported_frame_images: ["first_frame", "last_frame"],
        generate_audio: false,
        pricing_skus: { "per-video-second-1080p": String(model.usd) },
      })),
    ],
  };
  const entries = parseVideoCatalog(listing, READ_AT).entries;
  return { status: "read", catalog: { readAt: READ_AT, entries, dropped: [], failed: [], videoListing: listing } };
}

function choicesFor(plan: ScenePlan, modelId: string): ModelChoices {
  const shot = firstGenerate(plan);
  if (shot.source.kind !== "generate") throw new Error("generate");
  const modelClass = shot.source.modelClass;
  return modelChoicesSchema.parse({
    schema: "meridian.model_choices/v1",
    requestId: REQ,
    catalogReadAt: READ_AT,
    choices: [
      {
        shotId: shot.shotId,
        output: "shot",
        modelClass,
        modelChoice: { provider: "openrouter", modelId, source: "orchestrator", reason: "the cheapest eligible candidate", catalogReadAt: READ_AT },
      },
    ],
  });
}

test("a chosen call is priced at its chosen model's catalog estimate, and the other calls keep the price table", () => {
  const plan = planFixture();
  const shot = firstGenerate(plan);
  const before = estimatePlan(plan);
  const shotLine = before.lines.find((line) => line.shotId === shot.shotId);
  assert.ok(shotLine);

  const chosen: ChosenCallPrices = new Map([[callPriceKey(shot.shotId, "shot"), { provider: "openrouter:alibaba/wan-2.6", perCallUsd: 0.2 }]]);
  const after = estimatePlan(plan, chosen);
  const line = after.lines.find((item) => item.shotId === shot.shotId);
  assert.equal(line?.provider, "openrouter:alibaba/wan-2.6", "the line names the chosen model");
  assert.equal(line?.estimateUsd, 0.2);
  assert.equal(after.lines.length, before.lines.length);
  // The estimate is the lines' sum: the chosen line replaces the price-table line, and the redo allowance follows the generated lines.
  assert.equal(after.estimateUsd, Number((before.estimateUsd - shotLine.estimateUsd + 0.2).toFixed(4)), "the estimate swaps the chosen line in");
  assert.equal(after.reservedUsd, Number((after.estimateUsd + after.redoAllowanceUsd).toFixed(4)));
  // Every other line is unchanged.
  for (const other of before.lines.filter((item) => item.shotId !== shot.shotId)) {
    assert.ok(after.lines.some((item) => item.shotId === other.shotId && item.provider === other.provider && item.estimateUsd === other.estimateUsd));
  }
});

test("with no chosen prices the estimate is the price table's, unchanged", () => {
  const plan = planFixture();
  assert.deepEqual(estimatePlan(plan, new Map()), estimatePlan(plan));
});

test("a chosen call with no usable price refuses the estimate: it never prices at zero", () => {
  const plan = planFixture();
  const shot = firstGenerate(plan);
  const chosen: ChosenCallPrices = new Map([[callPriceKey(shot.shotId, "shot"), { provider: "openrouter:x", perCallUsd: 0 }]]);
  assert.throws(() => estimatePlan(plan, chosen), (error: unknown) => error instanceof Error && /no usable chosen price/.test(error.message));
});

test("chosenCallPricesOf prices a choice at the router's own catalog estimate, and names the choices it cannot use", () => {
  const plan = planFixture();
  const shot = firstGenerate(plan);
  const duration = shot.endMs - shot.startMs;

  const usable = chosenCallPricesOf({ plan, choices: choicesFor(plan, "vendor/priced"), catalog: catalogOf([{ id: "vendor/priced", usd: 0.1 }]) });
  const price = usable.prices.get(callPriceKey(shot.shotId, "shot"));
  assert.equal(price?.provider, "openrouter:vendor/priced");
  assert.equal(price?.perCallUsd, Math.ceil(0.1 * (duration / 1000) * 10000 - 1e-9) / 10000, "the per-second estimate, rounded up to 4 decimals");
  assert.deepEqual(usable.notes, []);

  const gone = chosenCallPricesOf({ plan, choices: choicesFor(plan, "vendor/left-catalog"), catalog: catalogOf([{ id: "vendor/priced", usd: 0.1 }]) });
  assert.equal(gone.prices.size, 0, "a model that left the catalog is not priced");
  assert.match(gone.notes.join(" "), /no longer in the catalog, so the call is priced from the price table/);

  const offline = chosenCallPricesOf({ plan, choices: choicesFor(plan, "vendor/priced"), catalog: { status: "not_connected", reason: "NOT_CONNECTED: no key" } });
  assert.equal(offline.prices.size, 0);
  assert.match(offline.notes.join(" "), /NOT_CONNECTED/);
});

test("extendForPlan with chosen prices holds the chosen total, and in cap mode refuses an over-budget chosen total with the reason", async () => {
  const plan = planFixture();
  const shot = firstGenerate(plan);
  const store = memoryLedgerStore();
  const held = await reserveFixed(store, {
    requestId: REQ,
    workspaceId: WS,
    mode: "cap",
    requestBudgetUsd: 10,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    reservationId: HOLD,
  });
  assert.equal(held.reservation.state, "reserved");

  // A chosen model that costs more than the request budget: nothing is held, and the gate fails with the reason (no partial run).
  const over: ChosenCallPrices = new Map([[callPriceKey(shot.shotId, "shot"), { provider: "openrouter:vendor/dear", perCallUsd: 6 }]]);
  const refused = await extendForPlan(store, {
    requestId: REQ,
    workspaceId: WS,
    reservationId: HOLD,
    plan,
    requestBudgetUsd: 4,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    chosenPrices: over,
  });
  assert.equal(refused.gate.pass, false);
  assert.equal(refused.reservation, null);
  const detail = refused.gate.checks.find((item) => item.rule === "reservation_succeeded")?.detail ?? "";
  assert.match(detail, /request budget 4 USD is below the reservation/);
  assert.match(detail, /1 call priced at the chosen model's catalog price/);
  assert.equal((await store.getReservation(HOLD))?.state, "reserved", "the hold is kept as intake made it");

  // A chosen total within budget is held, and the reservation covers the chosen call.
  const within: ChosenCallPrices = new Map([[callPriceKey(shot.shotId, "shot"), { provider: "openrouter:vendor/cheap", perCallUsd: 0.2 }]]);
  const ok = await extendForPlan(store, {
    requestId: REQ,
    workspaceId: WS,
    reservationId: HOLD,
    plan,
    requestBudgetUsd: 4,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    chosenPrices: within,
  });
  assert.equal(ok.gate.pass, true, JSON.stringify(ok.gate.checks.filter((item) => !item.pass)));
  assert.ok(ok.reservation);
  assert.ok(ok.reservation.lines.some((line) => line.shotId === shot.shotId && line.provider === "openrouter:vendor/cheap" && line.estimateUsd === 0.2));
  assert.equal(ok.reservation.reservedUsd >= 0.2, true);
});
