import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { INITIAL_POLICY, policyFrom, readOrchestratorPolicy, writeOrchestratorPolicy } from "./policy-store.ts";

const ORG_A = "org_policy_a";
const ORG_B = "org_policy_b";
const ORG_C = "org_policy_c";

describe("orchestrator policy store (migration 0114; D12 retires the tolerance)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG_A);
    await seedWorkspace(db.sql, ORG_B);
    await seedWorkspace(db.sql, ORG_C);
  });

  after(async () => {
    await db.close();
  });

  test("a workspace with no stored policy reads the initial values, and no tolerance, because a budget is a line", async () => {
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_A), INITIAL_POLICY);
    assert.deepEqual(INITIAL_POLICY.disabledModelFamilies, ["google/veo"]);
    assert.equal("budgetTolerance" in INITIAL_POLICY, false);
  });

  test("turning a family on stores the change, normalized, and reads it back", async () => {
    const stored = await writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { disabledModelFamilies: [] } });
    assert.deepEqual(stored.disabledModelFamilies, []);
    assert.deepEqual((await readOrchestratorPolicy(db.sql, ORG_A)).disabledModelFamilies, []);
    const again = await writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { disabledModelFamilies: ["  Google/Veo "] } });
    assert.deepEqual(again.disabledModelFamilies, ["google/veo"]);
  });

  test("a row that still carries the retired tolerance keeps its disabled families when it is read", async () => {
    await db.sql`
      insert into orchestrator_policies (organization_id, policy, updated_by, updated_at)
      values (${ORG_C}, ${JSON.stringify({ disabledModelFamilies: ["example/family"], budgetTolerance: { percent: 5, cents: 10 } })}::jsonb, 'user_c', now())
    `;
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_C), { disabledModelFamilies: ["example/family"] });
  });

  test("a change that does not validate throws and writes nothing", async () => {
    const before = await readOrchestratorPolicy(db.sql, ORG_A);
    await assert.rejects(writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { disabledModelFamilies: ["bad family!"] } }));
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_A), before);
  });

  test("another workspace never reads a change made in this one", async () => {
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_B), INITIAL_POLICY);
  });
});

test("a stored policy that does not validate is replaced by the initial policy, so a malformed row never turns a family on", () => {
  assert.deepEqual(policyFrom({ disabledModelFamilies: "example/family" }), INITIAL_POLICY);
  assert.deepEqual(policyFrom({ disabledModelFamilies: "example/family", budgetTolerance: { percent: 10, cents: 25 } }), INITIAL_POLICY);
  assert.deepEqual(policyFrom("not an object"), INITIAL_POLICY);
  assert.deepEqual(policyFrom({ disabledModelFamilies: [] }).disabledModelFamilies, []);
});

test("policyFrom drops the retired budgetTolerance key before it parses, and keeps the families of the row", () => {
  assert.deepEqual(policyFrom({ disabledModelFamilies: [], budgetTolerance: { percent: 10, cents: 25 } }), { disabledModelFamilies: [] });
  assert.deepEqual(policyFrom({ disabledModelFamilies: ["example/family"], budgetTolerance: { percent: 10, cents: 25 } }), { disabledModelFamilies: ["example/family"] });
  assert.deepEqual(policyFrom({ budgetTolerance: { percent: 10, cents: 25 } }), INITIAL_POLICY, "a row with no families takes the initial families");
});
