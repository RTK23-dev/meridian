import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { gatewayFor, json } from "../claude/test/helpers.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { disabledFamiliesFor, editPlanStepFor, measuredAverageFor, planDraftFor, runPlanFor, textModelsFor } from "./api.ts";
import { writeBrandPolicy } from "./brand-policy.ts";
import { orchestratorPlanSchema, type OrchestratorPlan } from "./contracts.ts";
import { recordCostMeasurement } from "./holds.ts";
import { ORCHESTRATOR_LISTINGS } from "./live-catalog.ts";
import { writeOrchestratorPolicy } from "./policy-store.ts";
import { createPlanDraft, getPlan, recordPlanOutcome } from "./store.ts";

const ORG = "org_api_a";
const OTHER = "org_api_b";
const NOW = "2026-10-23T10:00:00.000Z";
const BRAND = "brand_api_a";
const BRAND_OF_THE_ORCHESTRATOR = "brand_api_orchestrator";
const BRIEF = { goal: "A short branded video", format: "a hook, a product shot, a call to action", userInputs: "", brand: { name: "Example", summary: "plain" }, budgetUsd: 10 };

/** The recorded listings, in the order the catalog reads them. A gateway built from them answers every catalog read: no test calls a provider. */
const listings = JSON.parse(readFileSync(new URL("./fixtures/openrouter-listings-trimmed-2026-10-20.json", import.meta.url), "utf8")).listings as Record<string, unknown>;
const listingReplies = () => ORCHESTRATOR_LISTINGS.map((listing) => json(200, listings[listing.path]));
const sample: OrchestratorPlan = orchestratorPlanSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8")));

describe("the switched-off families of a plan, at each entry point (D16): the workspace's, with the brand's added", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG, BRAND);
    await seedWorkspace(db.sql, OTHER);
    // The workspace switches one vendor off; the brand switches the sample's video vendor off; another brand switches the orchestrator's vendor off.
    await writeOrchestratorPolicy(db.sql, { organizationId: ORG, actorId: "user_admin_a", patch: { disabledModelFamilies: ["zeta-vendor"] } });
    await writeBrandPolicy(db.sql, { organizationId: ORG, brandId: BRAND, actorId: "user_admin_a", disabledModelFamilies: ["alibaba"] });
    await writeBrandPolicy(db.sql, { organizationId: ORG, brandId: BRAND_OF_THE_ORCHESTRATOR, actorId: "user_admin_a", disabledModelFamilies: ["anthropic"] });
    await createPlanDraft(db.sql, { id: "plan_brand", organizationId: ORG, title: "Branded", brief: BRIEF, orchestratorModel: sample.orchestrator.id, budgetUsd: 10, brandId: BRAND });
    await recordPlanOutcome(db.sql, { id: "plan_brand", organizationId: ORG, plan: sample, reasons: [], catalogReadAt: null });
    await createPlanDraft(db.sql, { id: "plan_plain", organizationId: ORG, title: "Plain", brief: BRIEF, orchestratorModel: sample.orchestrator.id, budgetUsd: 10 });
    await recordPlanOutcome(db.sql, { id: "plan_plain", organizationId: ORG, plan: sample, reasons: [], catalogReadAt: null });
    await createPlanDraft(db.sql, {
      id: "plan_vendor_draft",
      organizationId: ORG,
      title: "Draft under a switched-off vendor",
      brief: BRIEF,
      orchestratorModel: sample.orchestrator.id,
      budgetUsd: 10,
      brandId: BRAND_OF_THE_ORCHESTRATOR,
    });
    // The other organization has its own workspace family, and a brand with the same id as ours. Neither reaches our plans.
    await writeOrchestratorPolicy(db.sql, { organizationId: OTHER, actorId: "user_other", patch: { disabledModelFamilies: ["omega-vendor"] } });
    await writeBrandPolicy(db.sql, { organizationId: OTHER, brandId: BRAND, actorId: "user_other", disabledModelFamilies: ["omega-vendor"] });
  });

  after(async () => {
    await db.close();
  });

  test("a plan with a brand is held to the workspace's families and the brand's together", async () => {
    assert.deepEqual(await disabledFamiliesFor(db.sql, ORG, "plan_brand"), ["alibaba", "zeta-vendor"]);
  });

  test("a plan with no brand is held to the workspace's families alone", async () => {
    assert.deepEqual(await disabledFamiliesFor(db.sql, ORG, "plan_plain"), ["zeta-vendor"]);
  });

  test("another organization's brand and workspace families never reach these plans", async () => {
    assert.deepEqual(await disabledFamiliesFor(db.sql, ORG, "plan_brand"), ["alibaba", "zeta-vendor"], "the same brand id in the other organization adds nothing");
    assert.deepEqual(await disabledFamiliesFor(db.sql, OTHER, "plan_brand"), ["omega-vendor"], "a plan that is not the organization's has the workspace's families alone");
  });

  test("the editor refuses a step whose model a brand has switched off, and accepts the same edit on a plan with no brand", async () => {
    const change = { params: { aspect: "1:1", hero_line: "script.hook" } };
    const refused = await editPlanStepFor(
      db.sql,
      { organizationId: ORG, planId: "plan_brand", nodeId: "hero_still", change, now: () => NOW },
      { gateway: gatewayFor(listingReplies()).gateway },
    );
    assert.equal(refused.status, "refused");
    if (refused.status === "refused") assert.match(refused.reasons.join("\n"), /step shot_1: .+ is switched off by the workspace's model policy/);

    const plain = await editPlanStepFor(db.sql, { organizationId: ORG, planId: "plan_plain", nodeId: "hero_still", change, now: () => NOW }, { gateway: gatewayFor(listingReplies()).gateway });
    assert.equal(plain.status, "edited", "the workspace's families alone do not switch off this plan's models");
  });

  test("the planner's catalog holds none of a brand's families: a draft whose orchestrator a brand has switched off is refused, and no plan call is made", async () => {
    // The recorded listings answer the catalog read only. A plan call would need a further answer, which the gateway does not have.
    const outcome = await planDraftFor(
      db.sql,
      { organizationId: ORG, planId: "plan_vendor_draft", now: () => NOW },
      { gateway: gatewayFor(listingReplies()).gateway },
    );
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.match(outcome.reasons.join("\n"), /is switched off by the model policy, so no call is made/);
    assert.equal((await getPlan(db.sql, ORG, "plan_vendor_draft"))?.status, "refused");
  });

  test("the runner refuses a plan whose step a brand has switched off, before any call is made", async () => {
    const outcome = await runPlanFor(
      db.sql,
      { organizationId: ORG, planId: "plan_brand", now: () => NOW, measure: null },
      { gateway: gatewayFor(listingReplies()).gateway },
    );
    assert.equal(outcome.status, "not_runnable");
    if (outcome.status === "not_runnable") assert.match(outcome.reasons.join("\n"), /step shot_1: .+ is switched off by the workspace's model policy/);
    assert.equal((await getPlan(db.sql, ORG, "plan_brand"))?.status, "ready", "a refused run leaves the plan ready");
  });
});

describe("a workspace whose stored policy is unreadable: planning, runs, edits and the model list refuse with its reason, and nothing is written", () => {
  let db: TestDatabase;
  const ORG_BROKEN = "org_api_unreadable";
  const REASON = { message: "the workspace's orchestrator policy is unreadable; save the policy again" };

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG_BROKEN);
    // The families are a string, not a list: the row does not validate, so it is unreadable and no family is read from it.
    await db.sql`
      insert into orchestrator_policies (organization_id, policy, updated_by, updated_at)
      values (${ORG_BROKEN}, ${JSON.stringify({ disabledModelFamilies: "zeta-vendor" })}::jsonb, 'user_admin_b', now())
    `;
    await createPlanDraft(db.sql, { id: "plan_broken", organizationId: ORG_BROKEN, title: "Plan", brief: BRIEF, orchestratorModel: sample.orchestrator.id, budgetUsd: 10 });
    await recordPlanOutcome(db.sql, { id: "plan_broken", organizationId: ORG_BROKEN, plan: sample, reasons: [], catalogReadAt: null });
  });

  after(async () => {
    await db.close();
  });

  test("planning, a run, a step edit and the model list each refuse with the reason before any call, and the plan is unchanged", async () => {
    const deps = { gateway: gatewayFor(listingReplies()).gateway };
    const planBefore = await getPlan(db.sql, ORG_BROKEN, "plan_broken");
    await assert.rejects(planDraftFor(db.sql, { organizationId: ORG_BROKEN, planId: "plan_broken", now: () => NOW }, deps), REASON);
    await assert.rejects(runPlanFor(db.sql, { organizationId: ORG_BROKEN, planId: "plan_broken", now: () => NOW, measure: null }, deps), REASON);
    await assert.rejects(editPlanStepFor(db.sql, { organizationId: ORG_BROKEN, planId: "plan_broken", nodeId: "hero_still", change: { params: { aspect: "1:1" } }, now: () => NOW }, deps), REASON);
    await assert.rejects(textModelsFor(db.sql, { organizationId: ORG_BROKEN, now: () => NOW }, deps), REASON);
    assert.deepEqual(await getPlan(db.sql, ORG_BROKEN, "plan_broken"), planBefore, "a refused call writes nothing");
  });
});

describe("the measured average (D15): the organization's clips, shown, and never used to set a hold", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG);
    await seedWorkspace(db.sql, OTHER);
    await createPlanDraft(db.sql, { id: "plan_avg_a", organizationId: ORG, title: "Measured here", brief: BRIEF, orchestratorModel: sample.orchestrator.id, budgetUsd: 10 });
    await createPlanDraft(db.sql, { id: "plan_avg_b", organizationId: OTHER, title: "Measured there", brief: BRIEF, orchestratorModel: sample.orchestrator.id, budgetUsd: 10 });
  });

  after(async () => {
    await db.close();
  });

  test("the average is null until a clip is measured", async () => {
    assert.deepEqual(await measuredAverageFor(db.sql, ORG), { measuredAverageUsdPerSecond: null, clips: 0, seconds: 0 });
  });

  test("with clips measured, the average is the reported bills over their lengths", async () => {
    assert.equal(await recordCostMeasurement(db.sql, ORG, { planId: "plan_avg_a", cacheKey: "clip_avg_one", kind: "video", seconds: 5, actualUsd: 1 }), true);
    assert.equal(await recordCostMeasurement(db.sql, ORG, { planId: "plan_avg_a", cacheKey: "clip_avg_two", kind: "video", seconds: 5, actualUsd: 0.5 }), true);
    assert.deepEqual(await measuredAverageFor(db.sql, ORG), { measuredAverageUsdPerSecond: 0.15, clips: 2, seconds: 10 });
  });

  test("only the organization's clips are counted", async () => {
    assert.equal(await recordCostMeasurement(db.sql, OTHER, { planId: "plan_avg_b", cacheKey: "clip_avg_other", kind: "video", seconds: 1, actualUsd: 100 }), true);
    assert.deepEqual(await measuredAverageFor(db.sql, ORG), { measuredAverageUsdPerSecond: 0.15, clips: 2, seconds: 10 });
    assert.deepEqual(await measuredAverageFor(db.sql, OTHER), { measuredAverageUsdPerSecond: 100, clips: 1, seconds: 1 });
  });

  test("a clip cannot be recorded against a plan of another organization", async () => {
    assert.equal(await recordCostMeasurement(db.sql, ORG, { planId: "plan_avg_b", cacheKey: "clip_avg_cross", kind: "video", seconds: 1, actualUsd: 9 }), false);
    assert.deepEqual(await measuredAverageFor(db.sql, ORG), { measuredAverageUsdPerSecond: 0.15, clips: 2, seconds: 10 });
  });
});
