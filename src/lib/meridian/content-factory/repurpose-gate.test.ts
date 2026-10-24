// The decision check on a repurpose plan, on PGlite with a counting stub engine. The stub answers the plan's predicate with a probability,
// so the outcome (approved, review, rejected) and its lineage can be asserted. No provider is reached.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { FIXTURE_IDS, edlFixture } from "../../../engine/contracts/fixtures/index.ts";
import { writeArtifact } from "../../../engine/jobs/artifact-store.ts";
import { startEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import { defaultRepurposeSettings } from "../../../engine/repurpose/resolve.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { DecisionEngine, DecisionEngineId, DecisionRequest, DecisionResult } from "../decisions/types.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { startRepurpose } from "./repurpose.ts";
import { REPURPOSE_PLAN_QUESTION } from "./repurpose-gate.ts";

const WS = "ws_repurpose_gate";
const BRAND = "brand_repurpose_gate";
const ADMIN = "user_repurpose_gate_admin";
const REQ = FIXTURE_IDS.request;
const SESSION = "session_repurpose_gate";
const NOW = "2026-10-24T10:00:00.000Z";

let db: TestDatabase;

/** A stub engine that answers the plan's predicate with `probability`, and counts its calls. */
function stubEngine(id: DecisionEngineId, probability: number) {
  const requests: DecisionRequest[] = [];
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
    decide: async (request): Promise<DecisionResult> => {
      requests.push(request);
      const answers: Record<string, JevAnswer> = {};
      for (const key of Object.keys(request.questions)) {
        const spec = request.questions[key] as JevQuestionSpec;
        answers[key] = {
          questionId: spec.id,
          questionVersion: spec.version,
          type: spec.type,
          model: "stub-model",
          provider: id,
          evidenceRefs: [],
          evaluatedAt: NOW,
          status: "answered",
          answer: probability >= 0.5,
          probability,
          noul: probability,
          semantics: "probability",
          calibrationStatus: "uncalibrated",
        } as unknown as JevAnswer;
      }
      return {
        runId: randomUUID(),
        model: "stub-model",
        provider: id,
        inputHash: "stub-hash",
        cached: false,
        latencyMs: 2,
        answers,
        engineId: id,
        adapterVersion: engine.adapterVersion,
        requestedModel: "stub-model",
        returnedModel: "stub-model",
        inputModality: "text",
        imageCount: 0,
        imagesOmitted: 0,
      } as unknown as DecisionResult;
    },
  };
  return { engine, requests };
}

function registryWith(probability: number) {
  const jev = stubEngine("jev", probability);
  const openai = stubEngine("openai-decisions", probability);
  return { engines: { jev: jev.engine, "openai-decisions": openai.engine }, calls: () => jev.requests.length + openai.requests.length };
}

const settingsOf = (variantCount: number) => ({ ...defaultRepurposeSettings(), enabled: true, variantCount });

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${ADMIN}, ${ADMIN}, ${`${ADMIN}@fixture.example`}, true)`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${ADMIN}`}, ${WS}, ${ADMIN}, 'admin')`;
  await startEngineRequest(db.sql as never, {
    organizationId: WS,
    brandId: BRAND,
    requestId: REQ,
    formatId: "ref_repurpose_gate",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: "art_repurpose_gate_request",
  });
  const master = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "edit", type: "edl", body: edlFixture, createdAt: NOW });
  const state = JSON.parse((await db.sql<{ state: string }>`select state from engine_requests where id = ${REQ} and organization_id = ${WS}`)[0]!.state) as Record<string, unknown>;
  await db.sql`
    update engine_requests set status = 'delivered', state = ${JSON.stringify({
      ...state,
      status: "delivered",
      manifestId: "mf_repurpose_gate_fixture",
      masterEdlId: edlFixture.edlId,
      artifacts: { ...(state.artifacts as Record<string, string>), [`edl:${edlFixture.edlId}`]: master.artifactId },
    })}
    where id = ${REQ} and organization_id = ${WS}
  `;
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id)
    values (${SESSION}, ${WS}, ${BRAND}, ${ADMIN}, 'Gate reel', 'started', ${REQ})
  `;
});

after(async () => {
  await db.close();
});

describe("the decision check on a repurpose plan", () => {
  test("with no decision engine answering, the plan goes ahead and the check is recorded as not consulted", async () => {
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: SESSION, settings: settingsOf(2) });
    assert.equal(run.decision.outcome, "not_consulted");
    assert.equal(run.variations.length, 2, "the deterministic plan still goes ahead");
  });

  test("a high probability from an uncalibrated engine is review, not approval, and is recorded with the engine that gave it", async () => {
    const registry = registryWith(0.95);
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: SESSION, settings: settingsOf(1) }, { decision: { selection: { engineId: "jev", source: "workspace" }, engines: registry.engines } });
    assert.equal(run.decision.outcome, "review", "uncalibrated scores never auto-approve");
    assert.equal(run.decision.engineId, "jev");
    assert.equal(registry.calls(), 1, "one engine call for the whole plan, not one per variation");
  });

  test("a probability in the review band is recorded as review, and the plan still goes ahead", async () => {
    const registry = registryWith(0.7);
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: SESSION, settings: settingsOf(3) }, { decision: { selection: { engineId: "jev", source: "workspace" }, engines: registry.engines } });
    assert.equal(run.decision.outcome, "review");
    assert.equal(run.variations.length, 3);
  });

  test("a low probability from an uncalibrated engine does not block the plan: it is recorded as review", async () => {
    const registry = registryWith(0.1);
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: SESSION, settings: settingsOf(4) }, { decision: { selection: { engineId: "jev", source: "workspace" }, engines: registry.engines } });
    assert.equal(run.decision.outcome, "review", "an uncalibrated score never rejects; a calibrated one would");
    assert.equal(run.variations.length, 4);
  });

  test("a repeat of a planned run returns its recorded check and makes no engine call", async () => {
    const registry = registryWith(0.95);
    const first = await startRepurpose(db.sql, ADMIN, { sessionId: SESSION, settings: settingsOf(1) }, { decision: { selection: { engineId: "jev", source: "workspace" }, engines: registry.engines } });
    assert.equal(first.decision.outcome, "review");
    const callsBefore = registry.calls();
    const again = await startRepurpose(db.sql, ADMIN, { sessionId: SESSION, settings: settingsOf(1) }, { decision: { selection: { engineId: "jev", source: "workspace" }, engines: registry.engines } });
    assert.equal(again.runId, first.runId);
    assert.equal(again.decision.outcome, "review", "the recorded check is returned");
    assert.equal(registry.calls(), callsBefore, "a repeat makes no call");
  });

  test("the question is the plan's brand fit, a predicate on the plan's text", () => {
    assert.equal(REPURPOSE_PLAN_QUESTION.type, "noul");
    assert.deepEqual(REPURPOSE_PLAN_QUESTION.evidenceRequirements, ["treatment_plan"]);
    const spec: JevQuestionSpec = REPURPOSE_PLAN_QUESTION;
    assert.match(spec.instructions, /brand/);
  });
});

describe("the brand-fit check on a rendered variation", () => {
  // A stub renderer that renders every variation to a fixed video id, so the check and its recording can be read without a provider.
  const renders = { count: 0 };
  const renderStub = async () => {
    renders.count += 1;
    return { status: "rendered" as const, artifactId: `art_variant_check_${renders.count}` };
  };
  const rendering = { renderPriceUsd: () => 0.05, render: renderStub };

  test("a rendered variation is checked once, and the check is recorded on that variation as advisory review", async () => {
    const registry = registryWith(0.95);
    const callsBefore = registry.calls();
    const run = await startRepurpose(
      db.sql,
      ADMIN,
      { sessionId: SESSION, settings: { ...settingsOf(1), intensity: 4 } },
      { ...rendering, decision: { selection: { engineId: "jev", source: "workspace" }, engines: registry.engines } },
    );
    assert.equal(run.variations[0]?.status, "rendered", "the variation is rendered");
    assert.equal(run.variations[0]?.decision.outcome, "review", "the check is recorded on the variation");
    assert.equal(run.variations[0]?.decision.engineId, "jev", "with the engine that gave it");
    assert.equal(registry.calls() - callsBefore, 2, "one call for the plan and one for the rendered variation");
  });

  test("without a decision engine, a rendered variation is still rendered and its check is recorded as not consulted", async () => {
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: SESSION, settings: { ...settingsOf(1), intensity: 5 } }, rendering);
    assert.equal(run.variations[0]?.status, "rendered");
    assert.equal(run.variations[0]?.decision.outcome, "not_consulted");
    assert.equal(run.variations[0]?.decision.engineId, null);
  });

  test("a variation that is not rendered has no check to show", async () => {
    const run = await startRepurpose(db.sql, ADMIN, { sessionId: SESSION, settings: { ...settingsOf(1), intensity: 2 } }, { renderPriceUsd: () => undefined });
    assert.equal(run.variations[0]?.status, "not_priced");
    assert.equal(run.variations[0]?.decision.outcome, "not_consulted", "nothing was judged, and nothing is shown as judged");
  });
});
