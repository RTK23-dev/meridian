// The estimate_reserve stage against PostgreSQL (PGlite) with a model_choices input (Bible 10.5 step 5, 14.1 step 1): the chosen calls
// are priced from the chosen models' catalog estimates, the price table prices the rest, and cap mode refuses an over-budget total.
// Recorded catalog and fixtures only; no live call.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { reserveFixed } from "../../budget/preflight.ts";
import { withWorkspaceLedger } from "../sql-ledger-store.ts";
import { modelChoicesSchema, type ModelChoices } from "../../contracts/model-choices.ts";
import { FIXTURE_IDS, fixtureId, productionRequestFixture, scenePlanFixture } from "../../contracts/fixtures/index.ts";
import type { ScenePlan } from "../../contracts/index.ts";
import { parseVideoCatalog, type CatalogRead, type ModelCatalogSource } from "../../gateway/catalog.ts";
import { writeArtifact } from "../artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext } from "../types.ts";
import { createEstimateReserveHandler } from "./estimate-reserve.ts";

const READ_AT = "2026-10-16T09:00:00.000Z";
const WS = "ws_estimate_stage_chosen";
const REQ = FIXTURE_IDS.request;
const NOW = "2026-10-16T09:00:41.000Z";
const MODEL = "vendor/priced";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_fixture");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_fixture', 'fmt_fixture', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

/** The fixture plan with no references on its generated shots (the recorded catalog does not list how many a model takes). */
function planFixture(): ScenePlan {
  const plan = structuredClone(scenePlanFixture) as ScenePlan;
  for (const shot of plan.shots) {
    if (shot.source.kind === "generate") shot.source = { ...shot.source, refs: [] };
  }
  return plan;
}

/** The first generated video shot: the fixture's first generated shot is an avatar, which the recorded catalog does not list. */
function firstVideo(plan: ScenePlan) {
  const shot = plan.shots.find((candidate) => candidate.source.kind === "generate" && candidate.source.modelClass.startsWith("video."));
  if (!shot || shot.source.kind !== "generate") throw new Error("the fixture plan has a generated video shot");
  return { shot, modelClass: shot.source.modelClass };
}

function choicesOf(plan: ScenePlan, modelId: string): ModelChoices {
  const { shot, modelClass } = firstVideo(plan);
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

/** A catalog with one usable video model at the given per-second rate. */
function catalogOf(usd: number): ModelCatalogSource {
  const listing = {
    data: [
      {
        id: MODEL,
        supported_durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        supported_resolutions: ["1080p"],
        supported_aspect_ratios: ["9:16", "16:9"],
        supported_frame_images: ["first_frame", "last_frame"],
        generate_audio: false,
        pricing_skus: { "per-video-second-1080p": String(usd) },
      },
    ],
  };
  const read: CatalogRead = { status: "read", catalog: { readAt: READ_AT, entries: parseVideoCatalog(listing, READ_AT).entries, dropped: [], failed: [], videoListing: listing } };
  return { read: async () => read };
}

async function storeAs(type: "scene_plan" | "production_request" | "model_choices", body: unknown, parentIds: string[] = []): Promise<string> {
  const stored = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "plan", type, body, parentIds, createdAt: NOW });
  return stored.artifactId;
}

async function holdAs(reservationId: string, requestBudgetUsd: number): Promise<void> {
  await withWorkspaceLedger(db.sql, WS, (store) =>
    reserveFixed(store, { requestId: REQ, workspaceId: WS, mode: "cap", requestBudgetUsd, workspaceMonthBudgetUsd: 100, now: NOW, reservationId }),
  );
}

function stageContext(inputArtifactIds: string[], reservationId: string): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "estimate_reserve",
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: reservationId,
    inputArtifactIds,
    hints: [],
    details: {},
  };
  return { sql: db.sql, jobId: "job_estimate_stage_chosen", organizationId: WS, requestId: REQ, stage: "estimate_reserve", subjectId: REQ, attempt: "1", payload, signal: new AbortController().signal };
}

async function reservationLines(reservationId: string): Promise<Array<{ shotId?: string; provider?: string; estimateUsd: number }>> {
  const rows = await db.sql<{ body: string }>`
    select body from engine_artifacts where organization_id = ${WS} and type = 'budget_reservation' and request_id = ${REQ}
    order by created_at desc, id desc limit 1
  `;
  void reservationId;
  return (JSON.parse(rows[0]?.body ?? "{}") as { lines: Array<{ shotId?: string; provider?: string; estimateUsd: number }> }).lines;
}

test("the stage prices the chosen call from the model_choices input: the reservation holds the chosen model's catalog estimate", async () => {
  const hold = fixtureId("res_", 813);
  await holdAs(hold, 4);
  const plan = planFixture();
  const planId = await storeAs("scene_plan", plan);
  const requestId = await storeAs("production_request", { ...productionRequestFixture, constraints: { ...productionRequestFixture.constraints, budgetUsd: 4 } });
  const choicesId = await storeAs("model_choices", choicesOf(plan, MODEL), [planId]);

  const handler = createEstimateReserveHandler({ workspaceBudget: { monthBudget: async () => ({ status: "known", usd: 100 }) }, catalog: catalogOf(0.1) });
  const result = await handler.run(stageContext([planId, requestId, choicesId], hold));
  if (result.kind !== "done" || result.output.stage !== "estimate_reserve") assert.fail("expected an estimate output");
  assert.equal(result.output.gate.pass, true, JSON.stringify(result.output.gate.checks.filter((item) => !item.pass)));

  const { shot } = firstVideo(plan);
  const duration = shot.endMs - shot.startMs;
  const line = (await reservationLines(hold)).find((item) => item.shotId === shot.shotId);
  assert.equal(line?.provider, `openrouter:${MODEL}`, "the reservation holds the chosen model's line");
  assert.equal(line?.estimateUsd, Math.ceil(0.1 * (duration / 1000) * 10000 - 1e-9) / 10000, "the router's own per-call estimate");
});

test("without a catalog the same plan is priced from the price table, and the other calls are unchanged", async () => {
  const hold = fixtureId("res_", 814);
  await holdAs(hold, 4);
  const plan = planFixture();
  const planId = await storeAs("scene_plan", plan);
  const requestId = await storeAs("production_request", { ...productionRequestFixture, constraints: { ...productionRequestFixture.constraints, budgetUsd: 4 } });
  const choicesId = await storeAs("model_choices", choicesOf(plan, MODEL), [planId]);

  const handler = createEstimateReserveHandler({ workspaceBudget: { monthBudget: async () => ({ status: "known", usd: 100 }) } });
  const result = await handler.run(stageContext([planId, requestId, choicesId], hold));
  if (result.kind !== "done" || result.output.stage !== "estimate_reserve") assert.fail("expected an estimate output");
  assert.equal(result.output.gate.pass, true);
  const { shot } = firstVideo(plan);
  const line = (await reservationLines(hold)).find((item) => item.shotId === shot.shotId);
  assert.notEqual(line?.provider, `openrouter:${MODEL}`, "no catalog: the price table prices the call");
});

test("in cap mode a chosen total above the request budget is held with a note: the gate passes, and calls are gated by the line (D12)", async () => {
  const hold = fixtureId("res_", 815);
  await holdAs(hold, 1);
  const plan = planFixture();
  const planId = await storeAs("scene_plan", plan);
  const requestId = await storeAs("production_request", { ...productionRequestFixture, constraints: { ...productionRequestFixture.constraints, budgetUsd: 1 } });
  const choicesId = await storeAs("model_choices", choicesOf(plan, MODEL), [planId]);

  const handler = createEstimateReserveHandler({ workspaceBudget: { monthBudget: async () => ({ status: "known", usd: 100 }) }, catalog: catalogOf(50) });
  const result = await handler.run(stageContext([planId, requestId, choicesId], hold));
  if (result.kind !== "done" || result.output.stage !== "estimate_reserve") assert.fail("expected an estimate output");
  assert.equal(result.output.gate.pass, true, "a chosen total above the budget is held, not refused");
  assert.equal(result.output.budgetReservationId, hold, "the reservation id is returned");
  const row = await db.sql<{ reserved_usd: unknown }>`select reserved_usd from engine_reservations where organization_id = ${WS} and id = ${hold}`;
  assert.ok(Number(row[0]?.reserved_usd) > 1, "the hold is the chosen total, above the 1 USD budget");
});
