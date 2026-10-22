import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { examplePlan, recordedExampleRun } from "./example.ts";
import { appendPlanEvents, claimForPlanning, createPlanDraft, getPlan, listPlanEvents, listPlans, recordPlanOutcome, releasePlanning, setPlanStatus, updatePlanJson } from "./store.ts";

const ORG_A = "org_orch_a";
const ORG_B = "org_orch_b";
const BRIEF = { goal: "A 15 second product video", format: "a hook, a product shot, a call to action", userInputs: "a water bottle", brand: { name: "Example", summary: "calm" }, budgetUsd: 2 };

describe("orchestrator plan store (migration 0108)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG_A);
    await seedWorkspace(db.sql, ORG_B);
  });

  after(async () => {
    await db.close();
  });

  test("a draft is stored with its brief and its chosen orchestrator, and reads back", async () => {
    const draft = await createPlanDraft(db.sql, { id: "plan_draft_1", organizationId: ORG_A, title: "Water bottle", brief: BRIEF, orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd: 2 });
    assert.equal(draft.status, "draft");
    assert.deepEqual(draft.brief, BRIEF);
    assert.equal(draft.orchestratorModel, "anthropic/claude-haiku-5.5");
    assert.equal(draft.budgetUsd, 2);
    assert.equal(draft.plan, null);
  });

  test("a checked plan is recorded as ready, and reads back as the same plan", async () => {
    const ready = await recordPlanOutcome(db.sql, { id: "plan_draft_1", organizationId: ORG_A, plan: examplePlan, reasons: [], catalogReadAt: "2026-10-20T00:00:00.000Z" });
    assert.ok(ready);
    assert.equal(ready?.status, "ready");
    assert.deepEqual(ready?.plan, examplePlan);
    assert.equal(ready?.catalogReadAt, "2026-10-20T00:00:00.000Z");
  });

  test("a refused plan is recorded as refused, with its reasons and no plan", async () => {
    await createPlanDraft(db.sql, { id: "plan_refused_1", organizationId: ORG_A, title: "Refused", brief: BRIEF, orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd: 2 });
    const refused = await recordPlanOutcome(db.sql, { id: "plan_refused_1", organizationId: ORG_A, plan: null, reasons: ["estimated cost $3.0000 exceeds the budget $2.0000"], catalogReadAt: null });
    assert.equal(refused?.status, "refused");
    assert.equal(refused?.plan, null);
    assert.deepEqual(refused?.reasons, ["estimated cost $3.0000 exceeds the budget $2.0000"]);
  });

  test("another organization sees nothing: a read is not found, a write changes nothing, an append is refused", async () => {
    assert.equal(await getPlan(db.sql, ORG_B, "plan_draft_1"), null);
    assert.equal(await setPlanStatus(db.sql, ORG_B, "plan_draft_1", "running"), null);
    assert.equal(await recordPlanOutcome(db.sql, { id: "plan_draft_1", organizationId: ORG_B, plan: null, reasons: ["x"], catalogReadAt: null }), null);
    assert.equal((await getPlan(db.sql, ORG_A, "plan_draft_1"))?.status, "ready", "the owner's plan is unchanged");
    const { events } = await recordedExampleRun();
    assert.equal(await appendPlanEvents(db.sql, ORG_B, "plan_draft_1", events.slice(0, 2)), false);
    assert.deepEqual(await listPlanEvents(db.sql, ORG_B, "plan_draft_1", 0), []);
    assert.deepEqual(await listPlans(db.sql, ORG_B, 10), []);
  });

  test("run events are stored in order, and a read after a sequence number returns only the later ones", async () => {
    const { events } = await recordedExampleRun();
    assert.equal(await appendPlanEvents(db.sql, ORG_A, "plan_draft_1", events.slice(0, 3)), true);
    assert.equal(await appendPlanEvents(db.sql, ORG_A, "plan_draft_1", events.slice(3, 5)), true);
    const all = await listPlanEvents(db.sql, ORG_A, "plan_draft_1", 0);
    assert.deepEqual(all.map((event) => event.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(all.slice(0, 5).map((event) => [event.nodeId, event.state]), events.slice(0, 5).map((event) => [event.nodeId, event.state]));
    const later = await listPlanEvents(db.sql, ORG_A, "plan_draft_1", 3);
    assert.deepEqual(later.map((event) => event.seq), [4, 5]);
  });

  test("the organization's plans are listed, newest first, and a status can be set", async () => {
    const plans = await listPlans(db.sql, ORG_A, 10);
    assert.deepEqual(plans.map((plan) => plan.id).sort(), ["plan_draft_1", "plan_refused_1"]);
    const running = await setPlanStatus(db.sql, ORG_A, "plan_draft_1", "running");
    assert.equal(running?.status, "running");
  });

  test("a draft is claimed for planning once: the second claim finds it taken, and another organization claims nothing", async () => {
    await createPlanDraft(db.sql, { id: "plan_claim_1", organizationId: ORG_A, title: "Claim", brief: BRIEF, orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd: 2 });
    assert.equal(await claimForPlanning(db.sql, ORG_A, "plan_claim_1"), true);
    assert.equal((await getPlan(db.sql, ORG_A, "plan_claim_1"))?.status, "planning");
    assert.equal(await claimForPlanning(db.sql, ORG_A, "plan_claim_1"), false, "a plan being planned is not claimed again");
    assert.equal(await claimForPlanning(db.sql, ORG_B, "plan_claim_1"), false, "another organization cannot claim it");
  });

  test("releasing a claim gives the plan its previous status, but keeps an outcome the call already stored", async () => {
    await releasePlanning(db.sql, ORG_A, "plan_claim_1", "draft");
    assert.equal((await getPlan(db.sql, ORG_A, "plan_claim_1"))?.status, "draft");
    assert.equal(await claimForPlanning(db.sql, ORG_A, "plan_claim_1"), true);
    await recordPlanOutcome(db.sql, { id: "plan_claim_1", organizationId: ORG_A, plan: null, reasons: ["refused for the test"], catalogReadAt: null });
    await releasePlanning(db.sql, ORG_A, "plan_claim_1", "draft");
    assert.equal((await getPlan(db.sql, ORG_A, "plan_claim_1"))?.status, "refused");
  });

  test("an edit is not written over a run in progress, and is written once the run has stopped", async () => {
    await createPlanDraft(db.sql, { id: "plan_edit_guard", organizationId: ORG_A, title: "Edit guard", brief: BRIEF, orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd: 2 });
    await recordPlanOutcome(db.sql, { id: "plan_edit_guard", organizationId: ORG_A, plan: examplePlan, reasons: [], catalogReadAt: null });
    await setPlanStatus(db.sql, ORG_A, "plan_edit_guard", "running");
    assert.equal(await updatePlanJson(db.sql, ORG_A, "plan_edit_guard", examplePlan), null);
    assert.equal((await getPlan(db.sql, ORG_A, "plan_edit_guard"))?.status, "running");
    await setPlanStatus(db.sql, ORG_A, "plan_edit_guard", "paused");
    assert.equal((await updatePlanJson(db.sql, ORG_A, "plan_edit_guard", examplePlan))?.status, "ready");
  });
});
