import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { contractRequest } from "./contract-fixtures.ts";
import { createDecisionEngines, decideWithActiveEngine, type DecisionEngineRegistry } from "./dispatcher.ts";
import { parseDeploymentEngine, resolveActiveEngine, resolveEngineSelection, saveWorkspaceEngine } from "./selection.ts";
import type { DecisionEngine, DecisionEngineId, DecisionRequest, DecisionResult } from "./types.ts";

// Counting stub engines: they show which engine was called, and that the other one was not.
function countingEngine(id: DecisionEngineId, options: { fail?: boolean } = {}) {
  const calls: DecisionRequest[] = [];
  const engine: DecisionEngine = {
    id,
    adapterVersion: `${id}-stub.v1`,
    capabilities: () => ({
      engineId: id,
      questionKinds: ["predicate", "choice", "score"],
      inputModalities: ["text"],
      maxImages: 0,
      maxImageBytes: 0,
      imageMimeTypes: [],
      batchQuestions: true,
      reportsUsage: false,
      semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" },
    }),
    health: async () => ({ status: "READY" }),
    decide: async (request) => {
      calls.push(request);
      const failure = options.fail ? { kind: "provider_unavailable" as const, message: "stub outage" } : undefined;
      const result: DecisionResult = {
        runId: globalThis.crypto.randomUUID(),
        model: "stub-model",
        provider: id,
        inputHash: "stub-hash",
        cached: false,
        latencyMs: 1,
        answers: {},
        engineId: id,
        adapterVersion: engine.adapterVersion,
        requestedModel: "stub-model",
        returnedModel: "stub-model",
        inputModality: "text",
        imageCount: 0,
        imagesOmitted: 0,
        failure,
      };
      return result;
    },
  };
  return { engine, calls };
}

function registry(jev: ReturnType<typeof countingEngine>, openai: ReturnType<typeof countingEngine>): DecisionEngineRegistry {
  return { jev: jev.engine, "openai-decisions": openai.engine };
}

test("the workspace setting outranks the deployment default, which outranks jev", () => {
  assert.deepEqual(resolveEngineSelection({ workspace: "openai-decisions", deploymentValue: "jev" }), {
    engineId: "openai-decisions",
    source: "workspace",
  });
  assert.deepEqual(resolveEngineSelection({ deploymentValue: "openai-decisions" }), {
    engineId: "openai-decisions",
    source: "deployment",
  });
  assert.deepEqual(resolveEngineSelection({}), { engineId: "jev", source: "default" });
});

test("an invalid deployment value is ignored and reported, never guessed at", () => {
  const selection = resolveEngineSelection({ deploymentValue: "gpt-5-shadow" });
  assert.equal(selection.engineId, "jev");
  assert.equal(selection.source, "default");
  assert.equal(selection.invalidDeploymentValue, "gpt-5-shadow");
  assert.deepEqual(parseDeploymentEngine("  OpenAI-Decisions "), { engineId: "openai-decisions" }, "case and spacing are normalized");
});

test("production dispatch calls only the active engine and never the other one", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "dispatch-only-active");
  const jev = countingEngine("jev");
  const openai = countingEngine("openai-decisions");
  const engines = registry(jev, openai);
  await saveWorkspaceEngine(sql, {
    organizationId: tenant.organizationId,
    actorId: tenant.userId,
    engineId: "openai-decisions",
    targetHealth: { status: "READY" },
  });

  const request = { ...contractRequest(), organizationId: tenant.organizationId, brandId: tenant.brandId };
  const dispatched = await decideWithActiveEngine({ sql, request, engines });
  assert.equal(dispatched.engineId, "openai-decisions");
  assert.equal(openai.calls.length, 1);
  assert.equal(jev.calls.length, 0, "the JEV engine received no request");
  assert.equal(dispatched.persisted, true);

  const [run] = await sql<{ engine_id: string; adapter_version: string; requested_model: string }>`
    select engine_id, adapter_version, requested_model from jev_runs where id = ${dispatched.runId}
  `;
  assert.equal(run?.engine_id, "openai-decisions", "the lineage names the engine that decided");
  assert.equal(run?.adapter_version, "openai-decisions-stub.v1");
});

test("an active engine that fails is reported as failed; the other engine is not called in its place", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "dispatch-no-fallback");
  const jev = countingEngine("jev");
  const openai = countingEngine("openai-decisions", { fail: true });
  await saveWorkspaceEngine(sql, {
    organizationId: tenant.organizationId,
    actorId: tenant.userId,
    engineId: "openai-decisions",
    targetHealth: { status: "READY" },
  });
  const dispatched = await decideWithActiveEngine({
    sql,
    request: { ...contractRequest(), organizationId: tenant.organizationId, brandId: tenant.brandId },
    engines: registry(jev, openai),
  });
  assert.equal(dispatched.failure?.kind, "provider_unavailable");
  assert.equal(jev.calls.length, 0, "no silent switch to the other paid engine");
  assert.equal(openai.calls.length, 1);
});

test("a switch to an engine that is not READY is refused and keeps the previous valid selection", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "switch-refused");
  const before = await resolveActiveEngine(sql, tenant.organizationId);
  const result = await saveWorkspaceEngine(sql, {
    organizationId: tenant.organizationId,
    actorId: tenant.userId,
    engineId: "openai-decisions",
    targetHealth: { status: "NOT_CONFIGURED", message: "OPENAI_API_KEY is not configured for OpenAI Decisions." },
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /OPENAI_API_KEY/);
  const after = await resolveActiveEngine(sql, tenant.organizationId);
  assert.deepEqual(after, before, "the previous selection is kept");
  const audits = await sql<{ n: number }>`
    select count(*)::int as n from audit_log where organization_id = ${tenant.organizationId} and action = 'decision_engine.update'
  `;
  assert.equal(audits[0]?.n, 0, "a refused switch writes no audit record");
});

test("an engine id that is not registered is refused", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "switch-unknown");
  const result = await saveWorkspaceEngine(sql, {
    organizationId: tenant.organizationId,
    actorId: tenant.userId,
    engineId: "shadow-everything",
    targetHealth: { status: "READY" },
  });
  assert.equal(result.ok, false);
});

test("a saved switch is recorded with its previous and new engine, and does not leak to another organization", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "switch-saved");
  const neighbour = await studioTenant(sql, "switch-neighbour");
  const saved = await saveWorkspaceEngine(sql, {
    organizationId: tenant.organizationId,
    actorId: tenant.userId,
    engineId: "openai-decisions",
    targetHealth: { status: "READY" },
  });
  assert.equal(saved.ok, true);
  assert.equal((await resolveActiveEngine(sql, tenant.organizationId)).engineId, "openai-decisions");
  assert.equal((await resolveActiveEngine(sql, neighbour.organizationId)).engineId, "jev", "another tenant keeps its own selection");

  const [audit] = await sql<{ metadata: string; object_type: string }>`
    select metadata, object_type from audit_log where organization_id = ${tenant.organizationId} and action = 'decision_engine.update'
  `;
  assert.equal(audit?.object_type, "decision_engine");
  const metadata = JSON.parse(audit!.metadata) as Record<string, unknown>;
  assert.equal(metadata.from, "jev");
  assert.equal(metadata.to, "openai-decisions");
  assert.ok(!audit!.metadata.includes("sk-"), "the audit record carries no credential");
});

test("the real registry reports both engines with their health, capabilities, and versions", async () => {
  const engines = createDecisionEngines();
  const jevHealth = await engines.jev.health();
  assert.ok(["READY", "DEGRADED", "NOT_CONFIGURED", "UNAVAILABLE"].includes(jevHealth.status));
  assert.equal(engines["openai-decisions"].id, "openai-decisions");
  assert.equal(engines.jev.capabilities().maxImages, 0);
  assert.equal(engines["openai-decisions"].capabilities().maxImages, 128);
});
