import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { disabledFamiliesFor, planDraftFor, runPlanFor } from "./api.ts";
import { createPlanDraft, getPlan } from "./store.ts";
import {
  INITIAL_POLICY,
  UNREADABLE_POLICY_FAMILIES_REASON,
  UNREADABLE_POLICY_REASON,
  measureModeFor,
  orchestratorPolicySchema,
  policyFrom,
  readOrchestratorPolicy,
  requireOrchestratorPolicy,
  writeOrchestratorPolicy,
} from "./policy-store.ts";

const ORG_A = "org_policy_a";
const ORG_B = "org_policy_b";
const ORG_C = "org_policy_c";
const ORG_D = "org_policy_d";
const ORG_E = "org_policy_e";
const ORG_F = "org_policy_f";
const NOW = "2026-10-21T10:00:00.000Z";
const UNREADABLE = { status: "unreadable", reason: UNREADABLE_POLICY_REASON } as const;

describe("orchestrator policy store (migration 0114; D12 retires the tolerance)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    for (const organizationId of [ORG_A, ORG_B, ORG_C, ORG_D, ORG_E, ORG_F]) await seedWorkspace(db.sql, organizationId);
  });

  after(async () => {
    await db.close();
  });

  test("a workspace with no stored policy reads the initial values, and no tolerance, because a budget is a line", async () => {
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_A), { status: "ok", policy: INITIAL_POLICY });
    assert.deepEqual(INITIAL_POLICY.disabledModelFamilies, ["google/veo"]);
    assert.equal("budgetTolerance" in INITIAL_POLICY, false);
  });

  test("turning a family on stores the change, normalized, and reads it back", async () => {
    const stored = await writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { disabledModelFamilies: [] } });
    assert.deepEqual(stored.disabledModelFamilies, []);
    assert.deepEqual((await requireOrchestratorPolicy(db.sql, ORG_A)).disabledModelFamilies, []);
    const again = await writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { disabledModelFamilies: ["  Google/Veo "] } });
    assert.deepEqual(again.disabledModelFamilies, ["google/veo"]);
  });

  test("a row that still carries the retired tolerance keeps its disabled families and its ceiling when it is read; the tolerance key is dropped", async () => {
    await db.sql`
      insert into orchestrator_policies (organization_id, policy, updated_by, updated_at)
      values (${ORG_C}, ${JSON.stringify({ disabledModelFamilies: ["example/family"], measureCeilingUsdPerSecond: 2, budgetTolerance: { percent: 5, cents: 10 } })}::jsonb, 'user_c', now())
    `;
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_C), { status: "ok", policy: { disabledModelFamilies: ["example/family"], measureCeilingUsdPerSecond: 2 } });
  });

  test("a change that does not validate throws and writes nothing", async () => {
    const before = await readOrchestratorPolicy(db.sql, ORG_A);
    await assert.rejects(writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { disabledModelFamilies: ["bad family!"] } }));
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_A), before);
  });

  test("the measure ceiling starts at 0.50 USD a second, and is stored in the same row as the families", async () => {
    assert.equal(INITIAL_POLICY.measureCeilingUsdPerSecond, 0.5);
    const families = await requireOrchestratorPolicy(db.sql, ORG_A);
    const stored = await writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { measureCeilingUsdPerSecond: 1.25 } });
    assert.deepEqual(stored, { ...families, measureCeilingUsdPerSecond: 1.25 }, "the families stay as they were, and the ceiling changes");
    const rows = await db.sql<{ policy_json: string }>`select policy::text as policy_json from orchestrator_policies where organization_id = ${ORG_A}`;
    assert.deepEqual(JSON.parse(rows[0]?.policy_json ?? "{}"), stored, "both values are in the one stored row");
  });

  test("the measure ceiling takes 0.01 to 5 USD a second, and a value outside it writes nothing", async () => {
    for (const value of [0.01, 5]) {
      const stored = await writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { measureCeilingUsdPerSecond: value } });
      assert.equal(stored.measureCeilingUsdPerSecond, value, `${value} is in the range`);
    }
    for (const value of [0.009, 5.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { measureCeilingUsdPerSecond: value } }), `${value} is outside the range`);
    }
    assert.equal((await requireOrchestratorPolicy(db.sql, ORG_A)).measureCeilingUsdPerSecond, 5, "the last value in range stands; the refused ones wrote nothing");
  });

  test("another workspace never reads a change made in this one", async () => {
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_B), { status: "ok", policy: INITIAL_POLICY });
  });

  test("a stored row whose families are malformed is unreadable: the read reports it, and requireOrchestratorPolicy, which planning, runs and edits use, refuses with the reason", async () => {
    await db.sql`
      insert into orchestrator_policies (organization_id, policy, updated_by, updated_at)
      values (${ORG_D}, ${JSON.stringify({ disabledModelFamilies: "example/family", measureCeilingUsdPerSecond: 2 })}::jsonb, 'user_d', now())
    `;
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_D), UNREADABLE, "no policy is read from the row, so no family is reset or switched on");
    await assert.rejects(requireOrchestratorPolicy(db.sql, ORG_D), { message: UNREADABLE_POLICY_REASON });
  });

  test("a save over an unreadable row must state the families; with them the row is readable again, and an absent ceiling takes its initial value", async () => {
    await assert.rejects(writeOrchestratorPolicy(db.sql, { organizationId: ORG_D, actorId: "user_d", patch: { measureCeilingUsdPerSecond: 1 } }), { message: UNREADABLE_POLICY_FAMILIES_REASON });
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_D), UNREADABLE, "the refused save wrote nothing");
    const saved = await writeOrchestratorPolicy(db.sql, { organizationId: ORG_D, actorId: "user_d", patch: { disabledModelFamilies: ["vendor-y"] } });
    assert.deepEqual(saved, { disabledModelFamilies: ["vendor-y"], measureCeilingUsdPerSecond: 0.5 });
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_D), { status: "ok", policy: saved });
  });

  test("a row that lacks the families key refuses planning and runs before any claim or call; a workspace with no row keeps the initial families", async () => {
    await db.sql`
      insert into orchestrator_policies (organization_id, policy, updated_by, updated_at)
      values (${ORG_E}, ${JSON.stringify({ measureCeilingUsdPerSecond: 2 })}::jsonb, 'user_e', now())
    `;
    await createPlanDraft(db.sql, { id: "plan_policy_e", organizationId: ORG_E, title: "Plan", brief: {}, orchestratorModel: "orchestrator-stub", budgetUsd: 1 });
    const planBefore = await getPlan(db.sql, ORG_E, "plan_policy_e");
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_E), UNREADABLE, "the row is unreadable: its families are not filled in from the initial list");
    await assert.rejects(planDraftFor(db.sql, { organizationId: ORG_E, planId: "plan_policy_e", now: () => NOW }, {}), { message: UNREADABLE_POLICY_REASON });
    await assert.rejects(runPlanFor(db.sql, { organizationId: ORG_E, planId: "plan_policy_e", now: () => NOW, measure: null }, {}), { message: UNREADABLE_POLICY_REASON });
    assert.deepEqual(await getPlan(db.sql, ORG_E, "plan_policy_e"), planBefore, "a refused plan or run claims nothing and writes nothing");
    assert.deepEqual(await disabledFamiliesFor(db.sql, ORG_F, "plan_policy_none"), [...INITIAL_POLICY.disabledModelFamilies], "a workspace with no row plans with the initial families");
  });
});

test("a stored row whose families are malformed is unreadable with the exact reason: a list that is not a list is refused, not read as empty, and no family is switched on", () => {
  assert.equal(UNREADABLE_POLICY_REASON, "the workspace's orchestrator policy is unreadable; save the policy again");
  assert.deepEqual(policyFrom({ disabledModelFamilies: ["vendor-x", "not a family!"], measureCeilingUsdPerSecond: 2 }), UNREADABLE);
  assert.deepEqual(policyFrom({ disabledModelFamilies: "vendor-x", measureCeilingUsdPerSecond: 2 }), UNREADABLE, "a list that is not a list is unreadable");
});

test("a stored row whose ceiling is malformed, or that has an unknown key, is unreadable: its families are not reset to the initial list", () => {
  assert.deepEqual(policyFrom({ disabledModelFamilies: ["vendor-x"], measureCeilingUsdPerSecond: 9 }), UNREADABLE);
  assert.deepEqual(policyFrom({ disabledModelFamilies: ["vendor-x"], unexpected: true }), UNREADABLE, "an unknown key makes the row unreadable");
});

test("a stored value that is not an object, or whose families are not a list, is unreadable; an empty list is a list", () => {
  assert.deepEqual(policyFrom({ disabledModelFamilies: "example/family" }), UNREADABLE);
  assert.deepEqual(policyFrom({ disabledModelFamilies: "example/family", budgetTolerance: { percent: 10, cents: 25 } }), UNREADABLE);
  assert.deepEqual(policyFrom({ disabledModelFamilies: null }), UNREADABLE);
  assert.deepEqual(policyFrom("not an object"), UNREADABLE);
  assert.deepEqual(policyFrom(["google/veo"]), UNREADABLE);
  assert.deepEqual(policyFrom({ disabledModelFamilies: [], measureCeilingUsdPerSecond: 0.5 }), { status: "ok", policy: { disabledModelFamilies: [], measureCeilingUsdPerSecond: 0.5 } });
  assert.deepEqual(policyFrom({ disabledModelFamilies: [] }), UNREADABLE, "a row with no ceiling is unreadable: the ceiling is not filled in");
});

test("policyFrom drops the retired budgetTolerance key before it parses, and keeps the families of the row", () => {
  assert.deepEqual(policyFrom({ disabledModelFamilies: [], measureCeilingUsdPerSecond: 0.5, budgetTolerance: { percent: 10, cents: 25 } }), {
    status: "ok",
    policy: { disabledModelFamilies: [], measureCeilingUsdPerSecond: 0.5 },
  });
  assert.deepEqual(policyFrom({ disabledModelFamilies: ["example/family"], measureCeilingUsdPerSecond: 0.5, budgetTolerance: { percent: 10, cents: 25 } }), {
    status: "ok",
    policy: { disabledModelFamilies: ["example/family"], measureCeilingUsdPerSecond: 0.5 },
  });
  assert.deepEqual(policyFrom({ measureCeilingUsdPerSecond: 0.5, budgetTolerance: { percent: 10, cents: 25 } }), UNREADABLE, "a row with no families is unreadable: the initial families are not filled in");
  assert.deepEqual(policyFrom({ budgetTolerance: { percent: 10, cents: 25 } }), UNREADABLE, "a row that is only the retired key is unreadable, and no family is switched on");
});

test("the measure ceiling is checked by the same strict parse as the families: an unknown key, a missing value or an out-of-range value does not validate", () => {
  assert.equal(orchestratorPolicySchema.safeParse({ disabledModelFamilies: [], measureCeilingUsdPerSecond: 0.5, extra: true }).success, false, "an unknown key is refused");
  assert.equal(orchestratorPolicySchema.safeParse({ disabledModelFamilies: [] }).success, false, "the parsed policy carries its ceiling");
  assert.equal(orchestratorPolicySchema.safeParse({ disabledModelFamilies: [], measureCeilingUsdPerSecond: 0.001 }).success, false);
  assert.equal(orchestratorPolicySchema.safeParse({ disabledModelFamilies: [], measureCeilingUsdPerSecond: 5 }).success, true, "the top of the range is in it");
  assert.deepEqual(policyFrom({ disabledModelFamilies: [], measureCeilingUsdPerSecond: 9 }), UNREADABLE, "a ceiling out of range makes the stored row unreadable");
  assert.deepEqual(policyFrom({ disabledModelFamilies: [], measureCeilingUsdPerSecond: 2 }), { status: "ok", policy: { disabledModelFamilies: [], measureCeilingUsdPerSecond: 2 } });
  assert.deepEqual(policyFrom({ disabledModelFamilies: [] }), UNREADABLE, "a missing ceiling makes the stored row unreadable: it is not filled in with its initial value");
});

test("measure mode is off unless it is asked for; an admin's run takes the workspace's ceiling, and anyone else who asks is refused", () => {
  const policy = { disabledModelFamilies: [], measureCeilingUsdPerSecond: 0.75 };
  assert.deepEqual(measureModeFor(policy, { measure: false, admin: true }), { status: "off", measure: null });
  assert.deepEqual(measureModeFor(policy, { measure: false, admin: false }), { status: "off", measure: null }, "a run that does not ask takes none, whatever the role");
  assert.deepEqual(measureModeFor(policy, { measure: true, admin: true }), { status: "on", measure: { ceilingUsdPerSecond: 0.75 } });
  const refused = measureModeFor(policy, { measure: true, admin: false });
  assert.equal(refused.status, "refused");
  assert.match(refused.status === "refused" ? refused.reason : "", /Only a workspace admin may run a plan in measure mode/);
});
