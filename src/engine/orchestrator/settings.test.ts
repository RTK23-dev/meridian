import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import type { CatalogEntry } from "./catalog.ts";
import { getOrchestratorModel, isOrchestratorModelId, setOrchestratorModel, textChoices } from "./settings.ts";

const ORG_A = "org_orch_settings_a";
const ORG_B = "org_orch_settings_b";
const ACTOR = "user_orch_settings_admin";

function entry(overrides: Partial<CatalogEntry> & { id: string }): CatalogEntry {
  return {
    name: overrides.id,
    kind: "text",
    input_modalities: ["text"],
    output_modalities: ["text"],
    pricing: { promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000004, imageUsd: null, usdPerSecond1080p: null },
    ...overrides,
  };
}

describe("orchestrator model id shape", () => {
  test("a vendor/model id, with an optional live alias, is accepted", () => {
    assert.equal(isOrchestratorModelId("anthropic/claude-haiku-5.5"), true);
    assert.equal(isOrchestratorModelId("~anthropic/claude-opus-latest"), true);
  });

  test("anything that is not a vendor/model id is refused before it is stored", () => {
    for (const value of ["", "ab", "no-slash", "a/", "/model", "has space/model", "x/".padEnd(201, "a")]) {
      assert.equal(isOrchestratorModelId(value), false, value);
    }
  });
});

describe("text models the orchestrator can plan with", () => {
  test("only text models with both per-token prices are offered, sorted by name", () => {
    const catalog = new Map<string, CatalogEntry>([
      ["vendor/zeta", entry({ id: "vendor/zeta", name: "Zeta" })],
      ["vendor/alpha", entry({ id: "vendor/alpha", name: "Alpha" })],
      ["vendor/no-price", entry({ id: "vendor/no-price", name: "No price", pricing: { promptUsdPerToken: null, completionUsdPerToken: 0.000004, imageUsd: null, usdPerSecond1080p: null } })],
      ["vendor/picture", entry({ id: "vendor/picture", name: "Picture", kind: "image", pricing: { promptUsdPerToken: null, completionUsdPerToken: null, imageUsd: 0.04, usdPerSecond1080p: null } })],
    ]);
    assert.deepEqual(
      textChoices(catalog).map((choice) => choice.id),
      ["vendor/alpha", "vendor/zeta"],
    );
  });
});

describe("the stored orchestrator model (migration 0109)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG_A);
    await seedWorkspace(db.sql, ORG_B);
  });

  after(async () => {
    await db.close();
  });

  test("nothing is stored until a model is chosen", async () => {
    assert.equal(await getOrchestratorModel(db.sql, ORG_A), null);
  });

  test("a chosen model is stored and reads back, and choosing again replaces it without a second row", async () => {
    await setOrchestratorModel(db.sql, { organizationId: ORG_A, modelId: "anthropic/claude-haiku-5.5", actorId: ACTOR });
    await setOrchestratorModel(db.sql, { organizationId: ORG_A, modelId: "~anthropic/claude-opus-latest", actorId: ACTOR });
    assert.equal(await getOrchestratorModel(db.sql, ORG_A), "~anthropic/claude-opus-latest");
    const rows = await db.sql<{ n: number }>`select count(*)::int as n from orchestrator_settings where organization_id = ${ORG_A}`;
    assert.equal(rows[0]?.n, 1);
  });

  test("a malformed id is refused and the stored model is kept", async () => {
    await assert.rejects(setOrchestratorModel(db.sql, { organizationId: ORG_A, modelId: "not a model", actorId: ACTOR }), /vendor\/model/);
    assert.equal(await getOrchestratorModel(db.sql, ORG_A), "~anthropic/claude-opus-latest");
  });

  test("clearing removes the stored model", async () => {
    await setOrchestratorModel(db.sql, { organizationId: ORG_A, modelId: null, actorId: ACTOR });
    assert.equal(await getOrchestratorModel(db.sql, ORG_A), null);
  });

  test("another workspace never sees a model stored for this one", async () => {
    await setOrchestratorModel(db.sql, { organizationId: ORG_A, modelId: "vendor/model-a", actorId: ACTOR });
    assert.equal(await getOrchestratorModel(db.sql, ORG_B), null);
    await setOrchestratorModel(db.sql, { organizationId: ORG_B, modelId: "vendor/model-b", actorId: ACTOR });
    assert.equal(await getOrchestratorModel(db.sql, ORG_A), "vendor/model-a");
    assert.equal(await getOrchestratorModel(db.sql, ORG_B), "vendor/model-b");
  });
});
