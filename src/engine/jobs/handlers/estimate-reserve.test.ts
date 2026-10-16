import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { reserveFixed } from "../../budget/preflight.ts";
import { estimatePlan } from "../../budget/estimate.ts";
import { memoryLedgerStore, type LedgerStore } from "../../budget/store.ts";
import { EngineError, type GateResult, type ScenePlan } from "../../contracts/index.ts";
import { FIXTURE_IDS, fixtureId, productionRequestFixture, scenePlanFixture } from "../../contracts/fixtures/index.ts";
import { readArtifact, writeArtifact } from "../artifact-store.ts";
import { withWorkspaceLedger } from "../sql-ledger-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import type { EnginePayload, StageContext, StageOutput } from "../types.ts";
import { validateStageOutput } from "../validate.ts";
import {
  createEstimateReserveHandler,
  extendForPlan,
  type ExtendForPlanInput,
  type WorkspaceBudgetSource,
  type WorkspaceMonthBudget,
} from "./estimate-reserve.ts";

// The stage extends the pre-flight hold intake made (E3 lead decision 1). These tests hold the hold first, with reserveFixed,
// then check what estimate_reserve does to it: the same reservation id, raised to the plan, or left alone when it cannot be raised.

const REQ = FIXTURE_IDS.request;
const WS = "ws_estimate";
const HOLD = fixtureId("res_", 811);
const NOW = "2026-10-13T09:00:41.000Z";
const CREATED = "2026-10-13T09:00:05.000Z";
const PLAN_ESTIMATE = 0.9595;

function input(overrides: Partial<ExtendForPlanInput> = {}): ExtendForPlanInput {
  return {
    requestId: REQ,
    workspaceId: WS,
    reservationId: HOLD,
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

/** A pre-flight hold on the memory ledger, as intake makes it. */
async function holdIn(store: LedgerStore, budgetUsd = 4, monthUsd = 100): Promise<void> {
  const held = await reserveFixed(store, {
    requestId: REQ,
    workspaceId: WS,
    mode: "cap",
    requestBudgetUsd: budgetUsd,
    workspaceMonthBudgetUsd: monthUsd,
    now: NOW,
    reservationId: HOLD,
  });
  assert.equal(held.reservation.state, "reserved");
}

function checkOf(gate: GateResult, rule: string) {
  const found = gate.checks.find((item) => item.rule === rule);
  assert.ok(found, `check ${rule} is present`);
  return found;
}

test("the pre-flight hold is raised to the plan's estimate: the same reservation, the plan's lines, and the gate passes", async () => {
  const store = memoryLedgerStore();
  await holdIn(store);
  const result = await extendForPlan(store, input());
  assert.equal(result.gate.pass, true, JSON.stringify(result.gate.checks.filter((item) => !item.pass)));
  assert.ok(result.reservation);
  assert.equal(result.reservation.reservationId, HOLD);
  assert.equal(result.reservation.reservedUsd, PLAN_ESTIMATE);
  assert.equal(result.reservation.reservedUsd, estimatePlan(scenePlanFixture).reservedUsd);
  assert.equal((await store.getReservation(HOLD))?.reservedUsd, PLAN_ESTIMATE);
});

test("a hold is never lowered: a plan below the held amount keeps the larger hold", async () => {
  const store = memoryLedgerStore();
  await holdIn(store);
  const cheap: ScenePlan = { ...scenePlanFixture, shots: scenePlanFixture.shots.filter((shot) => shot.source.kind !== "generate") };
  const result = await extendForPlan(store, input({ plan: cheap }));
  assert.ok(result.reservation);
  assert.ok(result.reservation.reservedUsd >= 0.52, "the fixed lines stay in the hold");
});

test("in cap mode a raise over the request budget pauses: the gate fails with the reason, and the hold keeps its amount and state", async () => {
  const store = memoryLedgerStore();
  await holdIn(store, 0.6);
  const result = await extendForPlan(store, input({ requestBudgetUsd: 0.6 }));
  assert.equal(result.gate.pass, false);
  assert.equal(result.reservation, null);
  assert.match(checkOf(result.gate, "reservation_succeeded").detail ?? "", /request budget 0\.6 USD is below/);
  const kept = await store.getReservation(HOLD);
  assert.equal(kept?.state, "reserved");
  assert.equal(kept?.reservedUsd, 0.52);
});

test("an unknown price is refused with its shot named: the gate fails, and the hold is not touched", async () => {
  const store = memoryLedgerStore();
  await holdIn(store);
  const before = await store.getReservation(HOLD);
  const result = await extendForPlan(store, input({ plan: planWithUnknownPrice() }));
  assert.equal(result.gate.pass, false);
  assert.equal(result.reservation, null);
  assert.match(checkOf(result.gate, "reservation_succeeded").detail ?? "", /nothing is extended: shot .* has no known price/);
  assert.deepEqual(await store.getReservation(HOLD), before);
});

test("a plan that does not parse is refused as invalid input, before the hold is read", async () => {
  await assert.rejects(
    () => extendForPlan(memoryLedgerStore(), input({ plan: { schema: "meridian.scene_plan/v1" } })),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});

test("a hold that does not exist is refused as not found, and nothing is created", async () => {
  const store = memoryLedgerStore();
  await assert.rejects(
    () => extendForPlan(store, input()),
    (error: unknown) => error instanceof EngineError && error.kind === "not_found",
  );
  assert.equal(await store.getReservation(HOLD), null);
});

// --- The stage handler, against PostgreSQL (PGlite): it extends under the workspace lock and writes the reservation artifact. ---

let db: TestDatabase;

/** A workspace monthly budget the test sets. It is known, so the stage may extend. */
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
async function storeRequest(budgetUsd: number): Promise<string> {
  const stored = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "production_request",
    body: { ...productionRequestFixture, constraints: { ...productionRequestFixture.constraints, budgetUsd } },
    createdAt: CREATED,
  });
  return stored.artifactId;
}

/** Holds the pre-flight reservation in the database, as intake does, under the workspace lock. */
async function holdInDatabase(reservationId: string, budgetUsd = 4): Promise<void> {
  await withWorkspaceLedger(db.sql, WS, (store) =>
    reserveFixed(store, {
      requestId: REQ,
      workspaceId: WS,
      mode: "cap",
      requestBudgetUsd: budgetUsd,
      workspaceMonthBudgetUsd: 100,
      now: NOW,
      reservationId,
    }),
  );
}

function contextFor(inputArtifactIds: string[], reservationId: string | null): StageContext {
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
  options: { reservationId?: string | null; source?: WorkspaceBudgetSource; requestBudgetUsd?: number } = {},
): Promise<{ output: Extract<StageOutput, { stage: "estimate_reserve" }>; ctx: StageContext }> {
  const requestArtifactId = await storeRequest(options.requestBudgetUsd ?? 4);
  const reservationId = options.reservationId === undefined ? HOLD : options.reservationId;
  const ctx = contextFor([planArtifactId, requestArtifactId], reservationId);
  const handler = createEstimateReserveHandler(options.source === undefined ? {} : { workspaceBudget: options.source });
  const result = await handler.run(ctx);
  assert.equal(result.kind, "done");
  if (result.kind !== "done" || result.output.stage !== "estimate_reserve") assert.fail("expected an estimate_reserve output");
  return { output: result.output, ctx };
}

async function reservationRow(id: string): Promise<{ count: number; reservedUsd: number | null }> {
  const rows = await db.sql<{ n: number | string; reserved: string | null }>`
    select count(*) as n, max(reserved_usd::text) as reserved from engine_reservations where id = ${id}
  `;
  const row = rows[0];
  return { count: Number(row?.n ?? 0), reservedUsd: row?.reserved === null || row?.reserved === undefined ? null : Number(row.reserved) };
}

test("a funded hold is extended to the plan: the same id comes back, the artifact is written, and the output passes the job boundary", async () => {
  await holdInDatabase(HOLD);
  const planId = await storePlan(scenePlanFixture);
  const { output, ctx } = await runEstimate(planId, { source: fundedWorkspace });

  assert.equal(output.gate.pass, true, JSON.stringify(output.gate.checks.filter((item) => !item.pass)));
  assert.equal(output.budgetReservationId, HOLD);
  assert.ok(output.artifacts.budget?.startsWith("art_"), "the reservation is written as an artifact");
  assert.equal((await reservationRow(HOLD)).reservedUsd, PLAN_ESTIMATE);

  const artifact = await readArtifact(db.sql, { organizationId: WS, artifactId: output.artifacts.budget });
  assert.equal(artifact.envelope.type, "budget_reservation");
  assert.deepEqual(artifact.envelope.parentIds, [planId]);
  assert.doesNotThrow(() => validateStageOutput(output, ctx.payload));
});

test("running the same job again extends once: the reservation row is still one, and the same id comes back", async () => {
  await holdInDatabase(HOLD);
  const planId = await storePlan(scenePlanFixture);
  const first = await runEstimate(planId, { source: fundedWorkspace });
  const second = await runEstimate(planId, { source: fundedWorkspace });
  assert.equal(second.output.budgetReservationId, first.output.budgetReservationId);
  assert.equal(second.output.gate.pass, true);
  assert.equal((await reservationRow(HOLD)).count, 1);
});

test("no pre-flight hold on the payload: nothing is extended, the gate says why, and no reservation id is returned", async () => {
  const planId = await storePlan(scenePlanFixture);
  const { output } = await runEstimate(planId, { reservationId: null, source: fundedWorkspace });
  assert.equal(output.gate.pass, false);
  assert.equal(output.budgetReservationId, null);
  assert.match(checkOf(output.gate, "reservation_succeeded").detail ?? "", /intake made no pre-flight hold/);
  assert.deepEqual(output.artifacts, {});
});

test("when the workspace monthly budget is not connected (the default), the hold is left alone and the gate gives the reason", async () => {
  await holdInDatabase(fixtureId("res_", 812));
  const before = await reservationRow(fixtureId("res_", 812));
  const planId = await storePlan(scenePlanFixture);
  const { output } = await runEstimate(planId, { reservationId: fixtureId("res_", 812) });
  assert.equal(output.gate.pass, false);
  assert.equal(output.budgetReservationId, null);
  assert.match(checkOf(output.gate, "reservation_succeeded").detail ?? "", /monthly budget is not connected/);
  assert.deepEqual(await reservationRow(fixtureId("res_", 812)), before);
});

test("a monthly budget that is not a usable amount is refused before anything is extended", async () => {
  await holdInDatabase(fixtureId("res_", 813));
  const planId = await storePlan(scenePlanFixture);
  const { output } = await runEstimate(planId, { reservationId: fixtureId("res_", 813), source: monthSource(Number.NaN) });
  assert.equal(output.gate.pass, false);
  assert.match(checkOf(output.gate, "reservation_succeeded").detail ?? "", /not a usable amount/);
});

test("a raise that cap mode pauses returns no id and writes no artifact; the hold keeps its amount", async () => {
  await holdInDatabase(fixtureId("res_", 814), 0.6);
  const planId = await storePlan(scenePlanFixture);
  const { output } = await runEstimate(planId, { reservationId: fixtureId("res_", 814), source: fundedWorkspace, requestBudgetUsd: 0.6 });
  assert.equal(output.gate.pass, false);
  assert.equal(output.budgetReservationId, null);
  assert.deepEqual(output.artifacts, {});
  assert.equal((await reservationRow(fixtureId("res_", 814))).reservedUsd, 0.52);
});

test("a stage with no scene_plan among its inputs is refused, not guessed", async () => {
  const requestArtifactId = await storeRequest(4);
  const ctx = contextFor([requestArtifactId], HOLD);
  await assert.rejects(
    () => createEstimateReserveHandler({ workspaceBudget: fundedWorkspace }).run(ctx),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});
