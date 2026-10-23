import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { INITIAL_POLICY, policyFrom, readOrchestratorPolicy, writeOrchestratorPolicy } from "./policy-store.ts";

const ORG_A = "org_policy_a";
const ORG_B = "org_policy_b";

describe("orchestrator policy store (migration 0114)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG_A);
    await seedWorkspace(db.sql, ORG_B);
  });

  after(async () => {
    await db.close();
  });

  test("a workspace with no stored policy reads the initial values: Veo off, the default tolerance", async () => {
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_A), INITIAL_POLICY);
    assert.deepEqual(INITIAL_POLICY.disabledModelFamilies, ["google/veo"]);
    assert.deepEqual(INITIAL_POLICY.budgetTolerance, { percent: 10, cents: 25 });
  });

  test("turning a family on stores the change, normalized, and reads it back", async () => {
    const stored = await writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { disabledModelFamilies: [] } });
    assert.deepEqual(stored.disabledModelFamilies, []);
    assert.deepEqual((await readOrchestratorPolicy(db.sql, ORG_A)).disabledModelFamilies, []);
    const again = await writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { disabledModelFamilies: ["  Google/Veo "] } });
    assert.deepEqual(again.disabledModelFamilies, ["google/veo"]);
  });

  test("a partial change keeps the other keys", async () => {
    await writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { budgetTolerance: { percent: 5, cents: 10 } } });
    const policy = await readOrchestratorPolicy(db.sql, ORG_A);
    assert.deepEqual(policy.budgetTolerance, { percent: 5, cents: 10 });
    assert.deepEqual(policy.disabledModelFamilies, ["google/veo"]);
  });

  test("a change that does not validate throws and writes nothing", async () => {
    const before = await readOrchestratorPolicy(db.sql, ORG_A);
    await assert.rejects(writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { disabledModelFamilies: ["bad family!"] } }));
    await assert.rejects(writeOrchestratorPolicy(db.sql, { organizationId: ORG_A, actorId: "user_a", patch: { budgetTolerance: { percent: 150, cents: 0 } } }));
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_A), before);
  });

  test("another workspace never reads a change made in this one", async () => {
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG_B), INITIAL_POLICY);
  });
});

test("a stored policy that does not validate is replaced by the initial policy, so a malformed row never turns a family on", () => {
  assert.deepEqual(policyFrom({ disabledModelFamilies: "google/veo", budgetTolerance: { percent: 10, cents: 25 } }), INITIAL_POLICY);
  assert.deepEqual(policyFrom("not an object"), INITIAL_POLICY);
  assert.deepEqual(policyFrom({ disabledModelFamilies: [] }).disabledModelFamilies, []);
});
