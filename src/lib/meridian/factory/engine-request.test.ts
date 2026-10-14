import assert from "node:assert/strict";
import test from "node:test";
import { productionRequestSchema } from "../../../engine/contracts/request.ts";
import type { CreativePlan } from "../creative/plan.ts";
import { creativePlanFor, type PlanAttributes } from "./plan.ts";
import type { Concept } from "./pick.ts";
import { budgetPerMaster, engineRequestIdFor, mapVideoToEngineRequest, type EngineOnlyFields } from "./engine-request.ts";

const ORGANIZATION = "org-engine-fixture";
const PLAN_CREATED = "2026-10-14T09:00:00.000Z";
const JOB = "factory-var-engine-fixture-video";

/** A Factory plan as the Plan stage writes it: one video deliverable, 8 seconds, 9:16, with no cost set by anyone. */
function planFixture(): CreativePlan {
  const concept: Concept = {
    key: "demo|question|live demonstration-0",
    label: "demo / question hook / live demonstration 1",
    angle: "live demonstration",
    hookType: "question",
    format: "demo",
  };
  const attributes: PlanAttributes = { hook: "question", angle: "live demonstration", format: "demo", proof: "", cta: "", presenter: "", lengthMs: 8000 };
  return creativePlanFor({
    templateId: "tpl:run-engine-fixture:ad-0",
    concept,
    attributes,
    decisionId: "gate-engine-fixture",
    researchAdId: "ad-0",
    winnerScore: 0.5,
    productName: "Mesh sponge",
    audience: "",
    run: { formats: ["video"], automation: "full", intent: "organic", capTotalCents: 0 },
    now: PLAN_CREATED,
  });
}

function videoIdOf(plan: CreativePlan): string {
  const deliverable = plan.deliverables.find((item) => item.kind === "video");
  assert.ok(deliverable, "the plan has a video deliverable");
  return deliverable.id;
}

/** The plan once a person has set the cost of its master: the estimate names the video, and it is no longer unpriced. */
function pricedPlan(usd: number): CreativePlan {
  const plan = planFixture();
  const id = videoIdOf(plan);
  return { ...plan, estimatedCost: { ...plan.estimatedCost, totalEstimatedUsd: usd, perDeliverableUsd: { [id]: usd }, unpricedDeliverableIds: [] } };
}

/** The fields the engine needs that a Factory plan does not carry, as a caller who knows them would set them. */
const ENGINE_FIELDS: EngineOnlyFields = {
  formatId: "ugc-demo-hook",
  referenceVideo: "reference-video-1",
  keep: ["hook_mechanism"],
  change: ["product"],
  language: "en",
  beats: [{ beatId: "beat-1", role: "hook", text: "One swipe, and the mess is gone." }],
  visualRequests: [{ beatId: "beat-1", want: "product close-up", strength: "must" }],
  pageId: "page-engine-fixture",
  styleKitId: "style-engine-fixture",
  voiceId: "voice-engine-fixture",
  priority: "normal",
};

function requestIdFixture(): string {
  const requestId = engineRequestIdFor(JOB, PLAN_CREATED);
  assert.ok(requestId, "the fixture plan has a creation time");
  return requestId;
}

test("a priced Factory video maps to an engine request that the engine's schema accepts, with the plan's budget, duration and aspect", () => {
  const plan = pricedPlan(1.25);
  const result = mapVideoToEngineRequest({ organizationId: ORGANIZATION, requestId: requestIdFixture(), plan, deliverableId: videoIdOf(plan), engine: ENGINE_FIELDS });

  assert.equal(result.status, "mapped", JSON.stringify(result));
  if (result.status !== "mapped") return;
  const request = result.request;
  assert.equal(request.workspaceId, ORGANIZATION);
  assert.equal(request.constraints.budgetUsd, 1.25, "the budget is the plan's cost for this master");
  assert.equal(request.constraints.maxMs, 8000, "the duration is the plan's target, in milliseconds");
  assert.equal(request.constraints.aspect, "9:16");
  assert.equal(request.output.master, true);
  assert.equal(productionRequestSchema.safeParse(request).success, true, "the engine's own schema accepts the request");
  assert.equal(request.product, undefined, "nothing the caller did not give is set, and nothing is invented");
  assert.equal(request.format.videoDnaId, undefined);
});

test("a plan with no cost for its master needs a budget: no budget is set and no default number is used", () => {
  const plan = planFixture();
  const result = mapVideoToEngineRequest({ organizationId: ORGANIZATION, requestId: requestIdFixture(), plan, deliverableId: videoIdOf(plan), engine: ENGINE_FIELDS });

  assert.equal(result.status, "needs_budget");
  assert.equal("request" in result, false, "no request is returned without a budget");
  if (result.status !== "needs_budget") return;
  assert.ok(result.missing.includes("constraints.budgetUsd"), `the budget is named as missing: ${result.missing.join(", ")}`);
  assert.match(result.message, /no cost for this master/);
});

test("a cost the plan lists as unpriced is no cost, even when a number sits beside it", () => {
  const plan = pricedPlan(1.25);
  const id = videoIdOf(plan);
  const flagged: CreativePlan = { ...plan, estimatedCost: { ...plan.estimatedCost, unpricedDeliverableIds: [id] } };
  assert.equal(budgetPerMaster(flagged, id), null);
  assert.equal(mapVideoToEngineRequest({ organizationId: ORGANIZATION, requestId: requestIdFixture(), plan: flagged, deliverableId: id, engine: ENGINE_FIELDS }).status, "needs_budget");
});

test("fields that neither the plan nor the caller gives stay missing, and the result names each one", () => {
  const plan = pricedPlan(1.25);
  const result = mapVideoToEngineRequest({ organizationId: ORGANIZATION, requestId: requestIdFixture(), plan, deliverableId: videoIdOf(plan) });

  assert.equal(result.status, "incomplete");
  if (result.status !== "incomplete") return;
  for (const field of ["format.formatId", "format.referenceVideo", "format.keep", "format.change", "script.language", "script.beats", "visualRequests", "page.pageId", "page.styleKitId", "page.voiceId", "constraints.priority"]) {
    assert.ok(result.missing.includes(field), `${field} is named as missing`);
  }
  assert.equal(result.missing.includes("constraints.budgetUsd"), false, "the budget is set, so it is not missing");
  assert.equal(result.missing.includes("constraints.maxMs"), false, "the duration comes from the plan");
});

test("a request id the caller could not make is named as missing, not replaced", () => {
  const plan = pricedPlan(1.25);
  const result = mapVideoToEngineRequest({ organizationId: ORGANIZATION, requestId: null, plan, deliverableId: videoIdOf(plan), engine: ENGINE_FIELDS });
  assert.equal(result.status, "incomplete");
  if (result.status === "incomplete") assert.ok(result.missing.includes("requestId"));
});

test("a video that is not 9:16, or has no duration in the plan, is not mapped to a value the plan does not hold", () => {
  const plan = pricedPlan(1.25);
  const id = videoIdOf(plan);
  const wide: CreativePlan = { ...plan, deliverables: plan.deliverables.map((item) => (item.id === id ? { ...item, aspectRatio: "16:9" } : item)) };
  const wideResult = mapVideoToEngineRequest({ organizationId: ORGANIZATION, requestId: requestIdFixture(), plan: wide, deliverableId: id, engine: ENGINE_FIELDS });
  assert.equal(wideResult.status, "incomplete");
  if (wideResult.status === "incomplete") assert.ok(wideResult.missing.includes("constraints.aspect"));

  const untimed: CreativePlan = {
    ...plan,
    deliverables: plan.deliverables.map((item) => (item.id === id ? { ...item, targetDurationSeconds: undefined } : item)),
  };
  const untimedResult = mapVideoToEngineRequest({ organizationId: ORGANIZATION, requestId: requestIdFixture(), plan: untimed, deliverableId: id, engine: ENGINE_FIELDS });
  assert.equal(untimedResult.status, "incomplete");
  if (untimedResult.status === "incomplete") assert.ok(untimedResult.missing.includes("constraints.maxMs"));
});

test("the request id is a req_ ULID, the same for the same job and plan, and none when the plan has no creation time", () => {
  const id = requestIdFixture();
  assert.match(id, /^req_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(engineRequestIdFor(JOB, PLAN_CREATED), id, "the same job gives the same id");
  assert.notEqual(engineRequestIdFor("factory-another-video", PLAN_CREATED), id, "another job gives another id");
  assert.equal(engineRequestIdFor(JOB, "not a date"), null);
});
