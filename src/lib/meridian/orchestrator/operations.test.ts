// The role and tenancy checks of the orchestrator's server functions (operations.ts), against a migrated database. Each check runs as the
// server function runs it, with the signed-in user's id: a viewer reads, an admin changes, a member or a viewer who changes is refused, and a
// brand of another organization is refused for everyone who is not a member of it. Recorded replies only; no provider is called.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { gatewayFor, json } from "../../../engine/claude/test/helpers.ts";
import { orchestratorPlanSchema, type OrchestratorPlan } from "../../../engine/orchestrator/contracts.ts";
import { recordCostMeasurement } from "../../../engine/orchestrator/holds.ts";
import { ORCHESTRATOR_LISTINGS } from "../../../engine/orchestrator/live-catalog.ts";
import { readOrchestratorPolicy, requireOrchestratorPolicy } from "../../../engine/orchestrator/policy-store.ts";
import { appendPlanEvents, createPlanDraft, getPlan, recordPlanOutcome, setPlanStatus } from "../../../engine/orchestrator/store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import {
  approveBudgetAs,
  brandAccessFor,
  listApprovalsAs,
  measuredAverageAs,
  readBrandPolicyAs,
  readWorkspacePolicyAs,
  runPlanAs,
  saveBrandPolicyAs,
  saveWorkspacePolicyAs,
} from "./operations.ts";

const ORG = "org_ops_a";
const OTHER = "org_ops_b";
const BRAND = "brand_ops_a";
const OTHER_BRAND = "brand_ops_b";
const ADMIN = "user_ops_admin";
const MEMBER = "user_ops_member";
const VIEWER = "user_ops_viewer";
const OUTSIDER = "user_ops_outsider";
const OTHER_ADMIN = "user_ops_other_admin";
const BRIEF = { goal: "A short branded video", format: "a hook, a product shot, a call to action", userInputs: "", brand: { name: "Example", summary: "plain" }, budgetUsd: 10 };
const sample: OrchestratorPlan = orchestratorPlanSchema.parse(JSON.parse(readFileSync(new URL("../../../engine/orchestrator/fixtures/sample-plan.json", import.meta.url), "utf8")));
const listings = JSON.parse(readFileSync(new URL("../../../engine/orchestrator/fixtures/openrouter-listings-trimmed-2026-10-20.json", import.meta.url), "utf8")).listings as Record<string, unknown>;

/** A gateway that answers the four catalog listings, so a run that reads the catalog reads recorded replies only. */
const catalogGateway = () => gatewayFor(ORCHESTRATOR_LISTINGS.map((listing) => json(200, listings[listing.path]))).gateway;

const NOT_PERMITTED = /You do not have permission to do that\./;
const NOT_AVAILABLE = /That workspace is not available to you\./;

async function seedUser(sql: TestDatabase["sql"], id: string): Promise<void> {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@example.test`}, true) on conflict (id) do nothing`;
}

async function seedMember(sql: TestDatabase["sql"], organizationId: string, userId: string, role: string): Promise<void> {
  await sql`
    insert into memberships (id, organization_id, user_id, role) values (${`mem_${organizationId}_${userId}`}, ${organizationId}, ${userId}, ${role})
    on conflict (organization_id, user_id) do update set role = excluded.role
  `;
}

describe("the orchestrator's server functions: the role and the tenancy of each action (operations.ts)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    for (const id of [ADMIN, MEMBER, VIEWER, OUTSIDER, OTHER_ADMIN]) await seedUser(db.sql, id);
    await seedWorkspace(db.sql, ORG, BRAND);
    await seedWorkspace(db.sql, OTHER, OTHER_BRAND);
    await seedMember(db.sql, ORG, ADMIN, "admin");
    await seedMember(db.sql, ORG, MEMBER, "member");
    await seedMember(db.sql, ORG, VIEWER, "viewer");
    await seedMember(db.sql, OTHER, OTHER_ADMIN, "admin");
    await createPlanDraft(db.sql, { id: "plan_ops_draft", organizationId: ORG, title: "Draft", brief: BRIEF, orchestratorModel: sample.orchestrator.id, budgetUsd: 10, brandId: BRAND });
    await createPlanDraft(db.sql, { id: "plan_ops_paused", organizationId: ORG, title: "Paused", brief: BRIEF, orchestratorModel: sample.orchestrator.id, budgetUsd: 10, brandId: BRAND });
    await recordPlanOutcome(db.sql, { id: "plan_ops_paused", organizationId: ORG, plan: sample, reasons: [], catalogReadAt: null });
    await setPlanStatus(db.sql, ORG, "plan_ops_paused", "paused");
  });

  after(async () => {
    await db.close();
  });

  test("a brand's check admits a caller of the minimum role or above, and refuses a lower role, a non-member and a brand that is not there", async () => {
    assert.equal((await brandAccessFor(db.sql, ADMIN, BRAND, "admin")).organizationId, ORG);
    assert.equal((await brandAccessFor(db.sql, VIEWER, BRAND, "viewer")).role, "viewer");
    await assert.rejects(brandAccessFor(db.sql, MEMBER, BRAND, "admin"), NOT_PERMITTED);
    await assert.rejects(brandAccessFor(db.sql, VIEWER, BRAND, "admin"), NOT_PERMITTED);
    await assert.rejects(brandAccessFor(db.sql, OUTSIDER, BRAND, "viewer"), NOT_AVAILABLE);
    await assert.rejects(brandAccessFor(db.sql, ADMIN, "brand_ops_missing", "viewer"), /Brand not found\./);
  });

  test("only a workspace admin saves the workspace's policy: a member and a viewer are refused and nothing is stored", async () => {
    const before = await readOrchestratorPolicy(db.sql, ORG);
    await assert.rejects(saveWorkspacePolicyAs(db.sql, MEMBER, { brandId: BRAND, measureCeilingUsdPerSecond: 2 }), NOT_PERMITTED);
    await assert.rejects(saveWorkspacePolicyAs(db.sql, VIEWER, { brandId: BRAND, disabledModelFamilies: ["vendor-v"] }), NOT_PERMITTED);
    assert.deepEqual(await readOrchestratorPolicy(db.sql, ORG), before, "a refused save writes nothing");

    const saved = await saveWorkspacePolicyAs(db.sql, ADMIN, { brandId: BRAND, measureCeilingUsdPerSecond: 2 });
    assert.equal(saved.policy.measureCeilingUsdPerSecond, 2);
    const rows = await db.sql<{ updated_by: string }>`select updated_by from orchestrator_policies where organization_id = ${ORG}`;
    assert.equal(rows[0]?.updated_by, ADMIN, "the admin who saved it is recorded");
  });

  test("only a workspace admin saves a brand's policy: a member is refused, and the admin's list is stored and read back", async () => {
    await assert.rejects(saveBrandPolicyAs(db.sql, MEMBER, { brandId: BRAND, disabledModelFamilies: ["vendor-m"] }), NOT_PERMITTED);
    assert.deepEqual((await readBrandPolicyAs(db.sql, VIEWER, { brandId: BRAND })).brandFamilies, [], "the refused save stored nothing");

    const saved = await saveBrandPolicyAs(db.sql, ADMIN, { brandId: BRAND, disabledModelFamilies: ["vendor-b"] });
    assert.deepEqual(saved.brandFamilies, ["vendor-b"]);
    const viewed = await readBrandPolicyAs(db.sql, VIEWER, { brandId: BRAND });
    assert.deepEqual(viewed.brandFamilies, ["vendor-b"]);
    assert.ok(viewed.effectiveFamilies.includes("vendor-b"), "the brand's family is in the set a plan is held to");
  });

  test("only a workspace admin approves a budget: a member is refused and nothing is recorded; an admin's approval is recorded once, under that admin", async () => {
    await assert.rejects(approveBudgetAs(db.sql, MEMBER, { brandId: BRAND, planId: "plan_ops_paused", budgetUsd: 12 }), NOT_PERMITTED);
    assert.deepEqual((await listApprovalsAs(db.sql, VIEWER, { brandId: BRAND, planId: "plan_ops_paused" })).approvals, [], "a refused approval records nothing");

    const approved = await approveBudgetAs(db.sql, ADMIN, { brandId: BRAND, planId: "plan_ops_paused", budgetUsd: 12 });
    assert.equal(approved.outcome.status, "approved");
    const { approvals } = await listApprovalsAs(db.sql, VIEWER, { brandId: BRAND, planId: "plan_ops_paused" });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.actorId, ADMIN);
    assert.equal(approvals[0]?.approvedUsd, 12);
  });

  test("a run in measure mode is an admin's: a member or a viewer who asks is refused and the plan does not start; an admin's run reaches the engine with or without it", async () => {
    await assert.rejects(runPlanAs(db.sql, MEMBER, { brandId: BRAND, planId: "plan_ops_draft", measure: true }, { gateway: catalogGateway() }), NOT_PERMITTED);
    await assert.rejects(runPlanAs(db.sql, VIEWER, { brandId: BRAND, planId: "plan_ops_draft", measure: true }, { gateway: catalogGateway() }), NOT_PERMITTED);
    assert.equal((await getPlan(db.sql, ORG, "plan_ops_draft"))?.status, "draft", "a refused run did not start");

    for (const measure of [false, true]) {
      const { outcome } = await runPlanAs(db.sql, ADMIN, { brandId: BRAND, planId: "plan_ops_draft", measure }, { gateway: catalogGateway() });
      assert.equal(outcome.status, "not_runnable", "a draft has no checked plan, so the engine answers and nothing runs");
    }
  });

  test("a viewer reads the policies, the approvals and the measured average; an outsider reads none of them", async () => {
    assert.equal((await readWorkspacePolicyAs(db.sql, VIEWER, { brandId: BRAND })).policy.measureCeilingUsdPerSecond, 2);
    assert.equal((await readBrandPolicyAs(db.sql, VIEWER, { brandId: BRAND })).brandFamilies.length, 1);
    assert.equal((await listApprovalsAs(db.sql, VIEWER, { brandId: BRAND, planId: "plan_ops_paused" })).approvals.length, 1);
    assert.deepEqual(await measuredAverageAs(db.sql, VIEWER, { brandId: BRAND }), { measuredAverageUsdPerSecond: null, clips: 0, seconds: 0 });

    await assert.rejects(readWorkspacePolicyAs(db.sql, OUTSIDER, { brandId: BRAND }), NOT_AVAILABLE);
    await assert.rejects(readBrandPolicyAs(db.sql, OUTSIDER, { brandId: BRAND }), NOT_AVAILABLE);
    await assert.rejects(listApprovalsAs(db.sql, OUTSIDER, { brandId: BRAND, planId: "plan_ops_paused" }), NOT_AVAILABLE);
    await assert.rejects(measuredAverageAs(db.sql, OUTSIDER, { brandId: BRAND }), NOT_AVAILABLE);

    assert.equal(await recordCostMeasurement(db.sql, ORG, { planId: "plan_ops_paused", cacheKey: "clip_ops_one", kind: "video", seconds: 4, actualUsd: 2 }), true);
    assert.deepEqual(await measuredAverageAs(db.sql, VIEWER, { brandId: BRAND }), { measuredAverageUsdPerSecond: 0.5, clips: 1, seconds: 4 }, "the viewer sees the workspace's average");
  });

  test("another organization is refused: an admin of this workspace cannot act on the other's brand, and an admin of the other cannot act on this one's", async () => {
    await assert.rejects(saveWorkspacePolicyAs(db.sql, ADMIN, { brandId: OTHER_BRAND, measureCeilingUsdPerSecond: 3 }), NOT_AVAILABLE);
    await assert.rejects(approveBudgetAs(db.sql, ADMIN, { brandId: OTHER_BRAND, planId: "plan_ops_paused", budgetUsd: 13 }), NOT_AVAILABLE);
    await assert.rejects(runPlanAs(db.sql, ADMIN, { brandId: OTHER_BRAND, planId: "plan_ops_draft", measure: false }, { gateway: catalogGateway() }), NOT_AVAILABLE);
    await assert.rejects(readBrandPolicyAs(db.sql, ADMIN, { brandId: OTHER_BRAND }), NOT_AVAILABLE);
    await assert.rejects(saveBrandPolicyAs(db.sql, OTHER_ADMIN, { brandId: BRAND, disabledModelFamilies: ["vendor-x"] }), NOT_AVAILABLE);
    await assert.rejects(listApprovalsAs(db.sql, OTHER_ADMIN, { brandId: BRAND, planId: "plan_ops_paused" }), NOT_AVAILABLE);
    await assert.rejects(measuredAverageAs(db.sql, OTHER_ADMIN, { brandId: BRAND }), NOT_AVAILABLE);

    assert.equal((await requireOrchestratorPolicy(db.sql, ORG)).measureCeilingUsdPerSecond, 2, "nothing of this workspace changed");
    const own = await saveWorkspacePolicyAs(db.sql, OTHER_ADMIN, { brandId: OTHER_BRAND, measureCeilingUsdPerSecond: 3 });
    assert.equal(own.policy.measureCeilingUsdPerSecond, 3, "the other organization's admin acts on its own brand");
    assert.equal((await requireOrchestratorPolicy(db.sql, ORG)).measureCeilingUsdPerSecond, 2, "and this workspace is unchanged");
  });

  test("a deleted brand is not found, for a reader as for a writer", async () => {
    await db.sql`insert into brands (id, organization_id, name, created_by, deleted_at) values ('brand_ops_gone', ${ORG}, 'Gone', 'test', now())`;
    await assert.rejects(readWorkspacePolicyAs(db.sql, ADMIN, { brandId: "brand_ops_gone" }), /Brand not found\./);
    await assert.rejects(saveBrandPolicyAs(db.sql, ADMIN, { brandId: "brand_ops_gone", disabledModelFamilies: [] }), /Brand not found\./);
  });

  test("an unreadable workspace policy refuses each action that needs it, with its reason, and a save over it states the families", async () => {
    const REASON = { message: "the workspace's orchestrator policy is unreadable; save the policy again" };
    await createPlanDraft(db.sql, { id: "plan_ops_other_draft", organizationId: OTHER, title: "Other draft", brief: BRIEF, orchestratorModel: sample.orchestrator.id, budgetUsd: 10, brandId: OTHER_BRAND });
    // The families are a string, not a list: the row does not validate, so none of its values is used.
    await db.sql`update orchestrator_policies set policy = ${JSON.stringify({ disabledModelFamilies: "vendor-o", measureCeilingUsdPerSecond: 3 })}::jsonb where organization_id = ${OTHER}`;
    await assert.rejects(readWorkspacePolicyAs(db.sql, OTHER_ADMIN, { brandId: OTHER_BRAND }), REASON);
    await assert.rejects(readBrandPolicyAs(db.sql, OTHER_ADMIN, { brandId: OTHER_BRAND }), REASON);
    await assert.rejects(saveBrandPolicyAs(db.sql, OTHER_ADMIN, { brandId: OTHER_BRAND, disabledModelFamilies: ["vendor-o"] }), REASON, "the brand save is refused before anything is written");
    await assert.rejects(runPlanAs(db.sql, OTHER_ADMIN, { brandId: OTHER_BRAND, planId: "plan_ops_other_draft", measure: false }), REASON, "a run is refused before it starts");
    const brandRows = await db.sql<{ n: number }>`select count(*)::int as n from orchestrator_brand_policies where organization_id = ${OTHER} and brand_id = ${OTHER_BRAND}`;
    assert.equal(brandRows[0]?.n, 0, "the refused brand save stored nothing");
    await assert.rejects(saveWorkspacePolicyAs(db.sql, OTHER_ADMIN, { brandId: OTHER_BRAND, measureCeilingUsdPerSecond: 4 }), {
      message: "the workspace's orchestrator policy is unreadable; state the model families when you save it again",
    });
    const saved = await saveWorkspacePolicyAs(db.sql, OTHER_ADMIN, { brandId: OTHER_BRAND, disabledModelFamilies: ["vendor-o"], measureCeilingUsdPerSecond: 4 });
    assert.deepEqual(saved.policy, { disabledModelFamilies: ["vendor-o"], measureCeilingUsdPerSecond: 4 });
    assert.deepEqual((await readWorkspacePolicyAs(db.sql, OTHER_ADMIN, { brandId: OTHER_BRAND })).policy, saved.policy, "the saved policy is read back");
  });

  /** A plan paused at the given reason, as a run leaves it: the reason is its last paused event, and the plan reads as paused. */
  async function pausedAt(planId: string, brief: Record<string, unknown>, reason: string): Promise<void> {
    await createPlanDraft(db.sql, { id: planId, organizationId: ORG, title: planId, brief, orchestratorModel: sample.orchestrator.id, budgetUsd: 10, brandId: BRAND });
    await recordPlanOutcome(db.sql, { id: planId, organizationId: ORG, plan: sample, reasons: [], catalogReadAt: null });
    await appendPlanEvents(db.sql, ORG, planId, [{ nodeId: "script", state: "paused", outputHash: null, costUsd: null, reason }]);
    await setPlanStatus(db.sql, ORG, planId, "paused");
  }

  test("a category approval through the operations layer raises that category's line, and its audit row names the category", async () => {
    await pausedAt("plan_ops_copy", { ...BRIEF, copyBudgetUsd: 0.05 }, "copy budget reached, project not finished: the next step's hold of $0.1000 would take the spend past the $0.0500 copy budget (committed $0.0200)");
    const approved = await approveBudgetAs(db.sql, ADMIN, { brandId: BRAND, planId: "plan_ops_copy", budgetUsd: 0.5, category: "copy" });
    assert.equal(approved.outcome.status, "approved", "the category approval is not dropped on its way to the engine");
    assert.equal((approved.stored?.brief as { copyBudgetUsd?: number } | undefined)?.copyBudgetUsd, 0.5, "the copy line is raised");
    assert.equal(approved.stored?.budgetUsd, 10, "the total is not raised");
    const { approvals } = await listApprovalsAs(db.sql, VIEWER, { brandId: BRAND, planId: "plan_ops_copy" });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.previousUsd, 0.05);
    assert.equal(approvals[0]?.approvedUsd, 0.5);
    assert.match(approvals[0]?.reason ?? "", /^category copy; copy budget reached/);
  });

  test("a total approval at a workspace month pause is refused with the reason to raise the monthly budget in settings, and changes nothing", async () => {
    await pausedAt("plan_ops_month", BRIEF, "budget reached, project not finished: the workspace month has committed 5 USD, at or above its 5 USD budget, so no paid call starts");
    const before = await getPlan(db.sql, ORG, "plan_ops_month");
    const refused = await approveBudgetAs(db.sql, ADMIN, { brandId: BRAND, planId: "plan_ops_month", budgetUsd: 20 });
    assert.deepEqual(refused.outcome, { status: "refused", reasons: ["the workspace month is at its budget; raise the monthly budget in settings"] });
    assert.deepEqual(await getPlan(db.sql, ORG, "plan_ops_month"), before, "the plan is exactly as it was: its status, budgets and brief");
    assert.deepEqual((await listApprovalsAs(db.sql, VIEWER, { brandId: BRAND, planId: "plan_ops_month" })).approvals, [], "a refused approval records nothing");
  });
});
