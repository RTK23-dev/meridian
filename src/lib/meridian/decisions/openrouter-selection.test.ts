// OpenRouter Decisions in the database and in selection, on PGlite: the migration widens the engine checks without touching existing
// settings, a switch to OpenRouter is refused unless it is READY, one workspace's choices never reach another, and a failing
// OpenRouter call is reported and never answered by another engine.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { engineAcceptsImages } from "./capabilities.ts";
import { createDecisionEngines, decideWithActiveEngine } from "./dispatcher.ts";
import { OpenRouterDecisionsEngine, OPENROUTER_DECISIONS_EXAMPLE_MODEL } from "./openrouter-engine.ts";
import { readLatestOpenRouterCheck, readOpenRouterModel, recordOpenRouterCheck, writeOpenRouterModel } from "./openrouter-settings.ts";
import { persistDecisionLineage } from "./lineage.ts";
import { resolveActiveEngine, resolveEngineSelection, saveWorkspaceEngine } from "./selection.ts";
import type { DecisionEngine, DecisionRequest, DecisionResult } from "./types.ts";
import { recordedDecisionCatalogSource } from "./recorded-decision-catalog.ts";
import { memoryDecisionHolds } from "./holds.ts";

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations", "0132_openrouter_decisions.sql");
const ORG_A = "org_openrouter_selection_a";
const ORG_B = "org_openrouter_selection_b";
const ACTOR = "user_openrouter_selection";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG_A, "brand_openrouter_selection_a");
  await seedWorkspace(db.sql, ORG_B, "brand_openrouter_selection_b");
});

after(async () => {
  await db.close();
});

describe("the migration", () => {
  test("it accepts the new engine id in both engine checks, and rejects any other id", async () => {
    const settings = await db.sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'decision_engine_settings_engine_id_check'
    `;
    assert.match(settings[0]!.def, /openrouter-decisions/);
    const gates = await db.sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'decision_gate_records_engine_id_check'
    `;
    assert.match(gates[0]!.def, /openrouter-decisions/);
    await assert.rejects(
      db.sql`insert into decision_engine_settings (organization_id, engine_id, updated_by) values (${ORG_A}, 'not-an-engine', ${ACTOR})`,
    );
  });

  test("it keeps existing workspace settings: rows written under the old check keep their engine, and a second run changes nothing", async () => {
    // Put the database back in the state migration 0046 left it in, with real rows, then apply migration 0132 over them.
    await db.exec(`
      alter table decision_engine_settings drop constraint if exists decision_engine_settings_engine_id_check;
      alter table decision_engine_settings add constraint decision_engine_settings_engine_id_check check (engine_id in ('jev', 'openai-decisions'));
    `);
    await db.sql`delete from decision_engine_settings where organization_id in (${ORG_A}, ${ORG_B})`;
    await db.sql`insert into decision_engine_settings (organization_id, engine_id, updated_by) values (${ORG_A}, 'jev', ${ACTOR})`;
    await db.sql`insert into decision_engine_settings (organization_id, engine_id, updated_by) values (${ORG_B}, 'openai-decisions', ${ACTOR})`;

    await db.exec(readFileSync(MIGRATION, "utf8"));
    await db.exec(readFileSync(MIGRATION, "utf8"));

    const rows = await db.sql<{ organization_id: string; engine_id: string }>`
      select organization_id, engine_id from decision_engine_settings where organization_id in (${ORG_A}, ${ORG_B}) order by organization_id
    `;
    assert.deepEqual(rows, [
      { organization_id: ORG_A, engine_id: "jev" },
      { organization_id: ORG_B, engine_id: "openai-decisions" },
    ]);
    await db.sql`update decision_engine_settings set engine_id = 'openrouter-decisions' where organization_id = ${ORG_A}`;
    assert.equal((await db.sql<{ engine_id: string }>`select engine_id from decision_engine_settings where organization_id = ${ORG_A}`)[0]!.engine_id, "openrouter-decisions");
  });

  test("the check table accepts only passed and failed outcomes for the OpenRouter engine", async () => {
    await assert.rejects(
      db.sql`
        insert into decision_engine_checks (id, organization_id, engine_id, model, key_fingerprint, status, message, actor_id)
        values ('chk_bad_status', ${ORG_A}, 'openrouter-decisions', 'typesafe/jev-1.14', 'k', 'maybe', 'x', ${ACTOR})
      `,
    );
    await assert.rejects(
      db.sql`
        insert into decision_engine_checks (id, organization_id, engine_id, model, key_fingerprint, status, message, actor_id)
        values ('chk_bad_engine', ${ORG_A}, 'jev', 'typesafe/jev-1.14', 'k', 'passed', 'x', ${ACTOR})
      `,
    );
  });
});

describe("the workspace's OpenRouter settings and checks", () => {
  test("a saved model and a recorded check are read back for their own workspace only", async () => {
    await writeOpenRouterModel(db.sql, { organizationId: ORG_A, actorId: ACTOR, model: "typesafe/jev-1.13" });
    assert.equal(await readOpenRouterModel(db.sql, ORG_A), "typesafe/jev-1.13");
    assert.equal(await readOpenRouterModel(db.sql, ORG_B), null, "another workspace has no model of its own");

    await recordOpenRouterCheck(db.sql, {
      organizationId: ORG_A,
      actorId: ACTOR,
      check: {
        status: "passed",
        model: "typesafe/jev-1.13",
        keyFingerprint: "sk-or-…abcd",
        message: "The provider answered.",
        returnedModel: "typesafe/jev-1.13-20261014",
        upstreamProvider: "TypeSafe",
        providerRequestId: "gen-dec-1",
      },
    });
    const check = await readLatestOpenRouterCheck(db.sql, ORG_A);
    assert.equal(check?.status, "passed");
    assert.equal(check?.model, "typesafe/jev-1.13");
    assert.equal(check?.keyFingerprint, "sk-or-…abcd");
    assert.equal(await readLatestOpenRouterCheck(db.sql, ORG_B), null, "another workspace's check is never read");
  });

  test("the saved model and the audit trail hold no key", async () => {
    const audit = await db.sql<{ metadata: string }>`
      select metadata::text as metadata from audit_log where organization_id = ${ORG_A} and action like 'decision_engine.openrouter%'
    `;
    assert.ok(audit.length >= 2, "the model change and the check are both audited");
    for (const row of audit) assert.equal(row.metadata.includes("sk-or-v1"), false);
  });
});

describe("selection", () => {
  test("OpenRouter can be chosen only when it is READY; a CONFIGURED engine is refused and the active engine is kept", async () => {
    const refused = await saveWorkspaceEngine(db.sql, {
      organizationId: ORG_B,
      actorId: ACTOR,
      engineId: "openrouter-decisions",
      targetHealth: { status: "CONFIGURED", message: "No connection test has passed." },
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.previous.engineId, "openai-decisions", "the workspace keeps the engine it already had");
    assert.equal((await resolveActiveEngine(db.sql, ORG_B)).engineId, "openai-decisions");

    const orgABefore = (await resolveActiveEngine(db.sql, ORG_A)).engineId;
    const accepted = await saveWorkspaceEngine(db.sql, {
      organizationId: ORG_B,
      actorId: ACTOR,
      engineId: "openrouter-decisions",
      targetHealth: { status: "READY", message: "The connection test passed." },
    });
    assert.equal(accepted.ok, true);
    assert.equal((await resolveActiveEngine(db.sql, ORG_B)).engineId, "openrouter-decisions");
    assert.equal((await resolveActiveEngine(db.sql, ORG_A)).engineId, orgABefore, "one workspace's choice does not reach another");
  });

  test("the deployment's OpenRouter choice is accepted, and an unknown engine is still reported", () => {
    assert.deepEqual(resolveEngineSelection({ deploymentValue: "openrouter-decisions" }), { engineId: "openrouter-decisions", source: "deployment" });
    const unknown = resolveEngineSelection({ deploymentValue: "openrouter" });
    assert.equal(unknown.engineId, "jev");
    assert.equal(unknown.invalidDeploymentValue, "openrouter", "an unknown value is reported, not guessed at");
  });

  test("the image rule comes from the engine's capability, so OpenRouter takes images and JEV does not", () => {
    assert.equal(engineAcceptsImages("openrouter-decisions"), true);
    assert.equal(engineAcceptsImages("openai-decisions"), true);
    assert.equal(engineAcceptsImages("jev"), false);
  });
});

describe("dispatch", () => {
  function recordingEngine(id: "jev" | "openai-decisions"): { engine: DecisionEngine; calls: number } {
    const state = { engine: null as unknown as DecisionEngine, calls: 0 };
    state.engine = {
      id,
      adapterVersion: `${id}-recording.v1`,
      capabilities: () => ({ engineId: id, questionKinds: [], inputModalities: [], maxImages: 0, maxImageBytes: 0, imageMimeTypes: [], batchQuestions: false, reportsUsage: false, semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" } }),
      health: async () => ({ status: "READY" }),
      async decide(): Promise<DecisionResult> {
        state.calls += 1;
        return { runId: "run", engineId: id, adapterVersion: "x", requestedModel: "m", returnedModel: "m", model: "m", provider: id, inputHash: "h", cached: false, latencyMs: 0, answers: {}, inputModality: "text", imageCount: 0, imagesOmitted: 0 };
      },
    } as DecisionEngine;
    return state;
  }

  test("an OpenRouter failure is reported as that failure: no other engine is called, and no answer is invented", async () => {
    const jev = recordingEngine("jev");
    const openai = recordingEngine("openai-decisions");
    const failingFetch = (async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })) as unknown as typeof fetch;
    const openrouter = new OpenRouterDecisionsEngine({ holds: memoryDecisionHolds(),
      fetchImpl: failingFetch,
      catalog: recordedDecisionCatalogSource(),
      keys: { async keyFor() { return { secret: "sk-or-v1-dispatch-secret", fingerprint: "sk-or-…cret", reason: "" }; } },
      store: { async workspaceModel() { return OPENROUTER_DECISIONS_EXAMPLE_MODEL; }, async latestCheck() { return null; } },
    });
    const engines = { jev: jev.engine, "openai-decisions": openai.engine, "openrouter-decisions": openrouter } as ReturnType<typeof createDecisionEngines>;
    const decided = await decideWithActiveEngine({
      request: {
        organizationId: ORG_B,
        brandId: "brand_openrouter_selection_b",
        state: { description: "A ticket." },
        questions: { refund: { id: "q.refund.v1", version: "1.0.0", type: "noul", instructions: "Refund?", criteria: { true: "a", false: "b" }, evidenceRequirements: [], policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 } } as never },
      },
      engines,
      selection: { engineId: "openrouter-decisions", source: "workspace" },
    });
    assert.equal(decided.engineId, "openrouter-decisions");
    assert.equal(decided.failure?.kind, "rate_limited");
    assert.equal(jev.calls, 0, "JEV is never called as a fallback");
    assert.equal(openai.calls, 0, "OpenAI is never called as a fallback");
    assert.equal(JSON.stringify(decided).includes("sk-or-v1-dispatch-secret"), false, "the key is in no result");
  });

  test("the default engine registry covers every engine id, including OpenRouter", () => {
    const registry = createDecisionEngines({ openrouter: new OpenRouterDecisionsEngine({ holds: memoryDecisionHolds() }) });
    assert.deepEqual(Object.keys(registry).sort(), ["jev", "openai-decisions", "openrouter-decisions"]);
    assert.equal(registry["openrouter-decisions"].id, "openrouter-decisions");
  });
});

describe("lineage", () => {
  test("a decision run keeps the engine, the models, the usage and the provider's own identifiers, and no key", async () => {
    const result = {
      runId: "run_openrouter_lineage_1",
      engineId: "openrouter-decisions",
      adapterVersion: "openrouter-decisions-adapter.v1",
      requestedModel: "typesafe/jev-1.14",
      returnedModel: "typesafe/jev-1.14-20261014",
      model: "typesafe/jev-1.14-20261014",
      provider: "openrouter",
      inputHash: "hash_openrouter_lineage",
      cached: false,
      latencyMs: 12,
      answers: {},
      inputModality: "text",
      imageCount: 0,
      imagesOmitted: 0,
      usage: { inputTokens: 357, outputTokens: 38, totalTokens: 395, reportedCostUsd: 0.0000149 },
      upstreamProvider: "TypeSafe",
      providerRequestId: "gen-dec-lineage-1",
    } as unknown as DecisionResult;
    const request = { organizationId: ORG_A, brandId: "brand_openrouter_selection_a", state: { description: "A ticket." }, questions: {} } as unknown as DecisionRequest;
    assert.equal(await persistDecisionLineage(db.sql as never, request, result), true);
    const rows = await db.sql<{ engine_id: string; requested_model: string; upstream_provider: string; provider_request_id: string; reported_cost: string }>`
      select engine_id, requested_model, upstream_provider, provider_request_id, usage->>'reportedCostUsd' as reported_cost
      from jev_runs where id = ${"run_openrouter_lineage_1"}
    `;
    assert.deepEqual(rows[0], {
      engine_id: "openrouter-decisions",
      requested_model: "typesafe/jev-1.14",
      upstream_provider: "TypeSafe",
      provider_request_id: "gen-dec-lineage-1",
      reported_cost: "0.0000149",
    });
    const leaked = await db.sql<{ found: number }>`select count(*)::int as found from jev_runs where id = ${"run_openrouter_lineage_1"} and metadata::text like ${"%sk-or-%"}`;
    assert.equal(leaked[0]!.found, 0, "no key is stored in the run");
  });
});
