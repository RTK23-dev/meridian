import assert from "node:assert/strict";
import test from "node:test";
import type { CreativePlan } from "../creative/plan.ts";
import { creativePlanFor, type PlanAttributes } from "./plan.ts";
import type { Concept } from "./pick.ts";
import { engineRequestIdFor, mapVideoToEngineRequest, type EngineOnlyFields } from "./engine-request.ts";

// The page's kits fill request.page when a theme page is given. Without one, the engine's own fields are used, as before.

const ORGANIZATION = "org-engine-page-fixture";
const PLAN_CREATED = "2026-10-15T09:00:00.000Z";
const JOB = "factory-var-engine-page-fixture-video";

function pricedPlan(usd: number): CreativePlan {
  const concept: Concept = {
    key: "demo|question|live demonstration-0",
    label: "demo / question hook / live demonstration 1",
    angle: "live demonstration",
    hookType: "question",
    format: "demo",
  };
  const attributes: PlanAttributes = { hook: "question", angle: "live demonstration", format: "demo", proof: "", cta: "", presenter: "", lengthMs: 8000 };
  const plan = creativePlanFor({
    templateId: "tpl:run-engine-page-fixture:ad-0",
    concept,
    attributes,
    decisionId: "gate-engine-page-fixture",
    researchAdId: "ad-0",
    winnerScore: 0.5,
    productName: "Mesh sponge",
    audience: "",
    run: { formats: ["video"], automation: "full", intent: "organic", capTotalCents: 0 },
    now: PLAN_CREATED,
  });
  const deliverable = plan.deliverables.find((item) => item.kind === "video");
  assert.ok(deliverable, "the plan has a video deliverable");
  return {
    ...plan,
    estimatedCost: { ...plan.estimatedCost, totalEstimatedUsd: usd, perDeliverableUsd: { [deliverable.id]: usd }, unpricedDeliverableIds: [] },
  };
}

function videoIdOf(plan: CreativePlan): string {
  const deliverable = plan.deliverables.find((item) => item.kind === "video");
  assert.ok(deliverable);
  return deliverable.id;
}

/** Everything the engine needs except the page fields, which each test sets itself. */
const FIELDS_WITHOUT_PAGE: EngineOnlyFields = {
  formatId: "ugc-demo-hook",
  referenceVideo: "reference-video-1",
  keep: ["hook_mechanism"],
  change: ["product"],
  language: "en",
  beats: [{ beatId: "beat-1", role: "hook", text: "One swipe, and the mess is gone." }],
  visualRequests: [{ beatId: "beat-1", want: "product close-up", strength: "must" }],
  priority: "normal",
};

function requestId(): string {
  const id = engineRequestIdFor(JOB, PLAN_CREATED);
  assert.ok(id);
  return id;
}

test("a theme page's kits fill request.page, and the engine's free-text page fields are not used", () => {
  const plan = pricedPlan(1.25);
  const result = mapVideoToEngineRequest({
    organizationId: ORGANIZATION,
    requestId: requestId(),
    plan,
    deliverableId: videoIdOf(plan),
    engine: { ...FIELDS_WITHOUT_PAGE, pageId: "free-text-page", styleKitId: "free-text-style", voiceId: "free-text-voice" },
    themePage: { pageId: "page-theme-1", styleKitId: "style-theme-1", personaId: "persona-theme-1", voiceId: "voice-theme-1" },
  });

  assert.equal(result.status, "mapped", JSON.stringify(result));
  if (result.status !== "mapped") return;
  assert.deepEqual(result.request.page, {
    pageId: "page-theme-1",
    styleKitId: "style-theme-1",
    personaId: "persona-theme-1",
    voiceId: "voice-theme-1",
  });
});

test("a kit the theme page does not set stays absent, so the engine schema reports it as missing", () => {
  const plan = pricedPlan(1.25);
  const result = mapVideoToEngineRequest({
    organizationId: ORGANIZATION,
    requestId: requestId(),
    plan,
    deliverableId: videoIdOf(plan),
    engine: { ...FIELDS_WITHOUT_PAGE, styleKitId: "free-text-style", voiceId: "free-text-voice" },
    themePage: { pageId: "page-theme-2", styleKitId: null, personaId: null, voiceId: "voice-theme-2" },
  });

  assert.equal(result.status, "incomplete");
  if (result.status !== "incomplete") return;
  assert.ok(result.missing.includes("page.styleKitId"), `the style kit is named as missing: ${result.missing.join(", ")}`);
  assert.equal(result.missing.includes("page.voiceId"), false, "the voice kit is set, so it is not missing");
});

test("without a theme page the engine's own page fields are used, as before", () => {
  const plan = pricedPlan(1.25);
  const result = mapVideoToEngineRequest({
    organizationId: ORGANIZATION,
    requestId: requestId(),
    plan,
    deliverableId: videoIdOf(plan),
    engine: { ...FIELDS_WITHOUT_PAGE, pageId: "page-engine-fixture", styleKitId: "style-engine-fixture", voiceId: "voice-engine-fixture" },
    themePage: null,
  });

  assert.equal(result.status, "mapped", JSON.stringify(result));
  if (result.status !== "mapped") return;
  assert.equal(result.request.page.pageId, "page-engine-fixture");
  assert.equal(result.request.page.styleKitId, "style-engine-fixture");
  assert.equal(result.request.page.voiceId, "voice-engine-fixture");
  assert.equal(result.request.page.personaId, undefined);
});
