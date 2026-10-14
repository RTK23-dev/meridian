import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { estimatePlan } from "../../budget/estimate.ts";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import { idSchema, type GateResult, type ScenePlan } from "../../contracts/index.ts";
import { FIXTURE_IDS, productionRequestFixture, scenePlanFixture } from "../../contracts/fixtures/index.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { sqlLedgerStore } from "../sql-ledger-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import {
  createEstimateReserveHandler,
  notConnectedWorkspaceBudget,
  planReservationId,
  reserveForPlan,
  type ReserveForPlanInput,
  type WorkspaceBudgetSource,
  type WorkspaceMonthBudget,
} from "./estimate-reserve.ts";

const REQ = FIXTURE_IDS.request;
const WS = "ws_estimate";
const PLAN_ART = FIXTURE_IDS.artPlan;
const OTHER_PLAN_ART = FIXTURE_IDS.artVoice;
const NOW = "2026-10-13T09:00:41.000Z";

function input(overrides: Partial<ReserveForPlanInput> = {}): ReserveForPlanInput {
  return {
    requestId: REQ,
    workspaceId: WS,
    planArtifactId: PLAN_ART,
    plan: scenePlanFixture,
    requestBudgetUsd: 4,
    workspaceMonthBudgetUsd: 100,
    now: NOW,
    ...overrides,
  };
}

/** The plan with its first shot priced by an image model, whose price is per token and so unknown (plan/cost.ts). */
function planWithUnknownPrice(): ScenePlan {
  const plan = structuredClone(scenePlanFixture);
  const shot = plan.shots[0];
  if (shot.source.kind !== "generate") throw new Error("the fixture's first shot is generated");
  plan.shots[0] = { ...shot, source: { ...shot.source, modelClass: "image.edit" } };
  return plan;
}

function checkOf(gate: GateResult, rule: string) {
  const found = gate.checks.find((item) => item.rule === rule);
  assert.ok(found, `check ${rule} is present`);
  return found;
}

test("a plan within the request budget reserves its estimate, and the budget gate passes", async () => {
  const store = memoryLedgerStore();
  const result = await reserveForPlan(store, input());
  assert.equal(result.gate.pass, true, JSON.stringify(result.gate.checks.filter((item) => !item.pass)));
  assert.equal(result.reservation?.state, "reserved");
  assert.equal(result.reservation?.reservedUsd, 0.9595, "the fixture plan's reservation (budget fixtures)");
  assert.equal(result.reservation?.reservedUsd, estimatePlan(scenePlanFixture).reservedUsd);
  assert.equal(result.created, true);
  assert.equal(result.reservation?.reservationId, planReservationId(REQ, PLAN_ART));
});

test("in cap mode a plan over the request budget is paused: the gate fails, the reason names the budget, and the hold is zero", async () => {
  const store = memoryLedgerStore();
  const result = await reserveForPlan(store, input({ requestBudgetUsd: 0.6 }));
  assert.equal(result.gate.pass, false);
  assert.equal(result.reservation?.state, "paused");
  assert.match(result.reservation?.pausedReason ?? "", /request budget 0\.6 USD is below the reservation of 0\.9595 USD/);
  assert.equal(checkOf(result.gate, "not_paused").pass, false);
  assert.equal(checkOf(result.gate, "reservation_succeeded").pass, false);

  const month = await store.sumForMonth(WS, NOW.slice(0, 7));
  assert.equal(month.reservedUsd, 0, "a paused reservation holds nothing for the workspace month");
});

test("a repeated reservation of one plan returns the same id and stores nothing new", async () => {
  const store = memoryLedgerStore();
  const first = await reserveForPlan(store, input());
  const second = await reserveForPlan(store, input());
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.reservation?.reservationId, first.reservation?.reservationId);
  assert.equal(second.gate.pass, true);

  const id = planReservationId(REQ, PLAN_ART);
  assert.equal(idSchema("res_").safeParse(id).success, true, "the id is a valid res_ ULID");
  assert.equal(planReservationId(REQ, PLAN_ART), id, "the id is a pure function of the request and the plan");
  assert.notEqual(planReservationId(REQ, OTHER_PLAN_ART), id, "another plan gets another id");
  assert.notEqual(planReservationId("req_other_request_id_0000000", PLAN_ART), id, "another request gets another id");
});

test("an unknown price is refused with its shot named: the gate fails, and nothing is stored", async () => {
  const store: LedgerStore = memoryLedgerStore();
  const result = await reserveForPlan(store, input({ plan: planWithUnknownPrice() }));
  assert.equal(result.gate.pass, false);
  assert.equal(result.reservation, null);
  assert.equal(result.created, false);
  assert.match(checkOf(result.gate, "reservation_succeeded").detail ?? "", /has no known price for nano_banana_2/);
  assert.equal(await store.getReservation(planReservationId(REQ, PLAN_ART)), null, "no reservation was stored");
});

test("a plan that does not parse is refused as invalid input", async () => {
  await assert.rejects(
    () => reserveForPlan(memoryLedgerStore(), input({ plan: { schema: "meridian.scene_plan/v1" } })),
    (error: unknown) => error instanceof Error && /scene plan does not parse/.test(error.message),
  );
});

// --- The stage handler, against PostgreSQL (PGlite): reserves under the workspace lock, and writes the reservation artifact. ---

let db: TestDatabase;
const CREATED = "2026-10-13T09:00:05.000Z";

/** A workspace monthly budget the test sets. It is known, so the stage may reserve. */
function monthSource(usd: number): WorkspaceBudgetSource {
  return { monthBudget: async (): Promise<WorkspaceMonthBudget> => ({ status: "known", usd }) };
}
const fundedWorkspace = monthSource(100);

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

async function storePlan(plan: unknown): Promise<string> {
  const stored = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "plan",
    type: "scene_plan",
    body: plan,
    createdAt: CREATED,
  });
  return stored.artifactId;
}

/** Stores a production request whose constraints.budgetUsd is the given amount, and returns its artifact id. */
async function storeRequest(budgetUsd: number, body: unknown = { ...productionRequestFixture, constraints: { ...productionRequestFixture.constraints, budgetUsd } }): Promise<string> {
  const stored = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "production_request",
    body,
    createdAt: CREATED,
  });
  return stored.artifactId;
}

function contextFor(inputArtifactIds: string[]): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "estimate_reserve",
    subjectId: REQ,
    attempt: "1",
    priority: "normal",
    budgetReservationId: null,
    inputArtifactIds,
    hints: [],
    details: {},
  };
  return {
    sql: db.sql,
    jobId: "job_estimate_test",
    organizationId: WS,
    requestId: REQ,
    stage: "estimate_reserve",
    subjectId: REQ,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}

async function runEstimate(
  planArtifactId: string,
  options: { source?: WorkspaceBudgetSource; requestBudgetUsd?: number } = {},
): Promise<{ output: Extract<StageOutput, { stage: "estimate_reserve" }>; ctx: StageContext }> {
  const requestArtifactId = await storeRequest(options.requestBudgetUsd ?? 4);
  const ctx = contextFor([planArtifactId, requestArtifactId]);
  const handler = createEstimateReserveHandler(options.source === undefined ? {} : { workspaceBudget: options.source });
  const result = await handler.run(ctx);
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "estimate_reserve") assert.fail("expected an estimate_reserve output");
  return { output: result.output, ctx };
}

async function reservationRows(id: string): Promise<number> {
  const rows = await db.sql<{ n: number | string }>`select count(*) as n from engine_reservations where id = ${id}`;
  return Number(rows[0]?.n ?? 0);
}

test("a funded plan reserves through the ledger, returns the reservation id, and writes the budget_reservation artifact", async () => {
  const planId = await storePlan(scenePlanFixture);
  const { output, ctx } = await runEstimate(planId, { source: fundedWorkspace });

  assert.equal(output.gate.pass, true, JSON.stringify(output.gate.checks.filter((item) => !item.pass)));
  const reservationId = planReservationId(REQ, planId);
  assert.equal(output.budgetReservationId, reservationId);
  assert.ok(output.artifacts.budget?.startsWith("art_"), "the reservation is written as an artifact");

  const stored = await sqlLedgerStore(db.sql, WS).getReservation(reservationId);
  assert.equal(stored?.state, "reserved");
  assert.equal(stored?.reservedUsd, 0.9595);

  const artifact = await readArtifact(db.sql, { organizationId: WS, artifactId: output.artifacts.budget });
  assert.equal(artifact.envelope.type, "budget_reservation");
  assert.deepEqual(artifact.envelope.parentIds, [planId]);
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
});

test("running the same job again returns the same reservation and stores no second row", async () => {
  const planId = await storePlan(scenePlanFixture);
  const first = await runEstimate(planId, { source: fundedWorkspace });
  const second = await runEstimate(planId, { source: fundedWorkspace });
  assert.equal(second.output.budgetReservationId, first.output.budgetReservationId);
  assert.equal(second.output.gate.pass, true);
  assert.equal(await reservationRows(planReservationId(REQ, planId)), 1);
});

test("a paused reservation returns no id and fails the gate; the paused reservation is stored with its reason", async () => {
  const planId = await storePlan(scenePlanFixture);
  const { output } = await runEstimate(planId, { source: fundedWorkspace, requestBudgetUsd: 0.6 });

  assert.equal(output.gate.pass, false);
  assert.equal(output.budgetReservationId, null, "no usable reservation id is returned for a paused stage");
  const reservation = await sqlLedgerStore(db.sql, WS).getReservation(planReservationId(REQ, planId));
  assert.equal(reservation?.state, "paused");
  assert.match(reservation?.pausedReason ?? "", /request budget 0\.6 USD/);
  assert.ok(output.artifacts.budget?.startsWith("art_"));
});

test("when the workspace monthly budget is not connected (the default), nothing is reserved and the gate gives the reason", async () => {
  const planId = await storePlan(scenePlanFixture);
  const { output } = await runEstimate(planId);

  assert.equal(output.gate.pass, false);
  assert.equal(output.budgetReservationId, null);
  assert.deepEqual(output.artifacts, {});
  assert.match(checkOf(output.gate, "reservation_succeeded").detail ?? "", /nothing is reserved: the workspace monthly budget is not connected/);
  assert.equal(await reservationRows(planReservationId(REQ, planId)), 0);
});

test("the default source is not connected, and a source that says so refuses with its reason", async () => {
  const answer = await notConnectedWorkspaceBudget.monthBudget({ organizationId: WS, requestId: REQ, now: NOW });
  assert.equal(answer.status, "not_connected");
  const planId = await storePlan(scenePlanFixture);
  const { output } = await runEstimate(planId, {
    source: { monthBudget: async () => ({ status: "not_connected", reason: "the test source has no budget" }) },
  });
  assert.equal(output.gate.pass, false);
  assert.match(checkOf(output.gate, "reservation_succeeded").detail ?? "", /the test source has no budget/);
  assert.equal(await reservationRows(planReservationId(REQ, planId)), 0);
});

test("a monthly budget that is not a usable amount is refused before anything is stored", async () => {
  for (const usd of [Number.NaN, -1]) {
    const planId = await storePlan(scenePlanFixture);
    const { output } = await runEstimate(planId, { source: monthSource(usd) });
    assert.equal(output.gate.pass, false, `usd ${usd} fails the gate`);
    assert.equal(output.budgetReservationId, null);
    assert.match(checkOf(output.gate, "reservation_succeeded").detail ?? "", /not a usable amount/);
    assert.equal(await reservationRows(planReservationId(REQ, planId)), 0);
  }
});

test("an unknown price fails the gate, names the shot, and stores no reservation", async () => {
  const planId = await storePlan(planWithUnknownPrice());
  const { output } = await runEstimate(planId, { source: fundedWorkspace });

  assert.equal(output.gate.pass, false);
  assert.equal(output.budgetReservationId, null);
  assert.deepEqual(output.artifacts, {});
  assert.equal(await reservationRows(planReservationId(REQ, planId)), 0);
});

test("a stage with no scene_plan among its inputs is refused, not guessed", async () => {
  await assert.rejects(
    () => createEstimateReserveHandler({ workspaceBudget: fundedWorkspace }).run(contextFor([])),
    (error: unknown) => error instanceof Error && /scene_plan input artifact/.test(error.message),
  );
});

test("a stage with no production_request among its inputs is refused: the request budget is not guessed", async () => {
  const planId = await storePlan(scenePlanFixture);
  await assert.rejects(
    () => createEstimateReserveHandler({ workspaceBudget: fundedWorkspace }).run(contextFor([planId])),
    (error: unknown) => error instanceof Error && /production_request input artifact/.test(error.message),
  );
  assert.equal(await reservationRows(planReservationId(REQ, planId)), 0);
});

