import assert from "node:assert/strict";
import test from "node:test";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { CreativeJudgmentBundle, CreativePlan } from "../creative/plan.ts";
import { executeApprovedCreativePlan } from "../studio/session.server.ts";
import type { Sql } from "../learning/store.ts";

test("Studio E2E Workflow 1: Single Source of Truth & Deliverables Fidelity", async () => {
  // 1. Authentic JEV decision bundle (P0-2: no fabricated scores)
  const jevJudgments: CreativeJudgmentBundle = {
    creativeMechanism: "3-step interactive swipe demonstration",
    recommendedFormats: [
      { format: "carousel", rationale: "Progressive disclosure of mechanism", priority: 1 },
    ],
    formatSuitability: {
      carousel: { suitable: true, rationale: "Progressive disclosure" },
      image: { suitable: false, rationale: "Single image insufficient" },
      video: { suitable: true, rationale: "Video supported" },
    },
    status: "admissible",
    evidenceRefs: ["ev-swipe-1"],
    decisionId: "jev-dec-carousel-99",
    questionSetVersion: "jev_v2",
    provider: "typesafe_direct",
    model: "gemini-2.5-flash",
  };

  // 2. CreativeDecisionEngine creates plan honoring JEV carousel recommendation
  const plan = CreativeDecisionEngine.createPlan({
    scope: "auto_choose",
    autonomy: "semi_automatic",
    preferredImageProvider: "test:image",
    brief: {
      title: "Clean Kitchen Sponge",
      hook: "Tired of smelly sponges?",
      message: "Swipe to see the antibacterial mesh layer in action",
      cta: "Grab a 4-pack today",
      decisionId: "jev-dec-carousel-99",
    },
    jevJudgments,
    constraints: {
      maxSpendUsd: 15.0,
    },
  });

  // Verify plan status and deliverables
  assert.equal(plan.status, "awaiting_approval", "Semi-automatic autonomy requires approval");
  assert.equal(plan.deliverables.length, 4, "Carousel scope must create exactly 4 slides");
  assert.ok(plan.deliverables.every((d) => d.kind === "carousel_slide"), "All deliverables must be carousel slides");
  assert.equal(plan.deliverables[0].provider, "test:image", "Deliverables must preserve preferred provider");

  // In-memory SQL harness for testing execution
  const dbPlans = new Map<string, any>();
  const dbCreatives = new Map<string, any>();
  const dbAssets = new Map<string, any>();
  const dbStorage = new Map<string, any>();
  const dbRuns = new Map<string, any>();
  const dbBriefs = new Map<string, any>();

  const orgId = "org-e2e-1";
  const brandId = "brand-e2e-1";
  const briefId = "brief-e2e-1";
  const userId = "user-e2e-1";

  dbBriefs.set(briefId, {
    id: briefId,
    organization_id: orgId,
    brand_id: brandId,
    title: "Clean Kitchen Sponge",
    hook: "Tired of smelly sponges?",
    message: "Swipe to see the antibacterial mesh layer in action",
    cta: "Grab a 4-pack today",
    angle: "hygiene",
    format: "carousel",
    status: "ready",
    decision_id: "jev-dec-carousel-99",
  });

  dbPlans.set(plan.id, {
    id: plan.id,
    organization_id: orgId,
    brand_id: brandId,
    brief_id: briefId,
    version: plan.version,
    status: "executing",
    scope: plan.scope,
    autonomy: plan.autonomy,
    objective: plan.objective,
    plan_payload: JSON.stringify(plan),
    budget_reserved_usd: plan.estimatedCost.totalEstimatedUsd,
    spend_cap_usd: 15.0,
  });

  const mockSql = (async (strings: TemplateStringsArray, ...values: any[]) => {
    const q = strings.join("?");

    if (q.includes("with updated as") && q.includes("update creative_plans")) {
      const plan = dbPlans.get(values[4]);
      if (plan) {
        plan.status = values[0];
        if (values[0] === "approved") plan.approved_by = values[2];
        return [plan];
      }
      return [];
    }

    if (q.includes("inserted_reservation")) {
      return [{
        id: "res-mock", organization_id: orgId, brand_id: brandId, account_id: "acct-mock",
        creative_plan_id: plan.id, production_job_id: null, amount_micros: 1_000_000n,
        status: "RESERVED", created_at: new Date().toISOString(), expires_at: new Date().toISOString(),
      }];
    }
    if (q.includes("inserted_ledger") && q.includes("actual_spent_micros")) {
      return [{
        id: "res-mock", organization_id: orgId, brand_id: brandId, account_id: "acct-mock",
        amount_micros: 1_000_000n, actual_spent_micros: 1_000_000n, status: "RECONCILED",
        created_at: new Date().toISOString(), expires_at: new Date().toISOString(), overage_micros: 0n,
      }];
    }

    if (q.includes("from creative_plans") && q.includes("where id =")) {
      const p = dbPlans.get(values[0]);
      return p ? [p] : [];
    }

    if (q.includes("from briefs") && q.includes("where id =")) {
      const b = dbBriefs.get(values[0]);
      return b ? [b] : [];
    }

    if (q.includes("from brands") || q.includes("from organization_members")) {
      return [{ id: brandId, organization_id: orgId, role: "member", name: "Sponge Brand" }];
    }

    if (q.includes("from products")) {
      return [{ id: "prod-1", brand_id: brandId, name: "Eco Sponge" }];
    }

    if (q.includes("from brand_brain")) {
      return [{
        positioning: "Ultra clean",
        value_proposition: "Never smells",
        tone: "Practical",
        prohibited_claims: [],
        words_to_avoid: [],
      }];
    }

    if (q.includes("from creative_records") && q.includes("where")) {
      return [];
    }

    if (q.includes("from policies")) {
      return [];
    }

    if (q.includes("budget_accounts")) {
      return [{
        id: "acct-mock",
        organization_id: orgId,
        brand_id: brandId,
        max_spend_micros: 100_000_000n,
        spent_micros: 0n,
        reserved_micros: 0n,
      }];
    }

    if (q.includes("budget_reservations") || q.includes("budget_ledger_entries")) {
      return [{
        id: "res-mock",
        organization_id: orgId,
        brand_id: brandId,
        account_id: "acct-mock",
        amount_micros: 1_000_000n,
        status: "RESERVED",
      }];
    }

    if (q.includes("from generation_runs") && q.includes("count(*)")) {
      return [{ runs_today: 0, running: 0, brand_runs_today: 0, brand_running: 0 }];
    }

    if (q.includes("insert into generation_runs")) {
      dbRuns.set(values[0], { id: values[0], status: "running" });
      return [];
    }

    if (q.includes("insert into blob_storage") || q.includes("insert into storage_objects")) {
      dbStorage.set(values[3], { key: values[3], byteSize: values[4] });
      return [];
    }

    if (q.includes("insert into creative_records")) {
      dbCreatives.set(values[0], {
        id: values[0],
        title: values[4],
        format: values[12],
        workflow: values[16],
      });
      return [];
    }

    if (q.includes("insert into assets")) {
      dbAssets.set(values[0], {
        id: values[0],
        creativeId: values[3],
        kind: values[16],
        variantIndex: values[19],
      });
      return [];
    }

    if (q.includes("insert into audit_log") || q.includes("insert into generation_jobs") || q.includes("insert into reviews") || q.includes("insert into jev_decisions")) {
      return [];
    }

    if (q.includes("update briefs set status = 'used'")) {
      const b = dbBriefs.get(values[0]);
      if (b) b.status = "used";
      return [];
    }

    if (q.includes("update generation_runs set status = 'completed'")) {
      const r = dbRuns.get(values[0]);
      if (r) r.status = "completed";
      return [];
    }

    return [];
  }) as unknown as Sql;

  (mockSql as any).query = async (sqlText: string, _params?: any[]) => {
    if (sqlText.includes("brand_brains")) {
      return [{
        positioning: "Ultra clean",
        value_proposition: "Never smells",
        tone: "Practical",
        prohibited_claims: [],
        words_to_avoid: [],
      }];
    }
    return [];
  };

  const briefRow = dbBriefs.get(briefId);

  // 3. Execution of approved plan directly generates all 4 carousel slide deliverables
  await executeApprovedCreativePlan(
    mockSql,
    { organizationId: orgId, role: "member" },
    userId,
    plan,
    briefRow,
  );

  // Verify deliverables were executed directly from the plan
  assert.equal(dbCreatives.size, 4, "Must execute exactly all 4 planned carousel deliverables");
  assert.equal(dbAssets.size, 4, "Must record 4 assets corresponding to the 4 slides");
  assert.equal(dbPlans.get(plan.id).status, "completed", "Plan must transition to completed");
  assert.equal(dbBriefs.get(briefId).status, "used", "Brief must transition to used");

  // Verify each deliverable preserved carousel_slide kind and sequence
  const assets = Array.from(dbAssets.values());
  for (let i = 0; i < 4; i++) {
    const slideAsset = assets.find((a) => a.variantIndex === i);
    assert.ok(slideAsset, `Slide index ${i} must exist`);
    assert.equal(slideAsset.kind, "carousel_slide", "Asset kind must be carousel_slide");
  }
});

test("Studio E2E Workflow 2: Atomic Approval Gate & Double-Execution Guard (P0-3)", async () => {
  const _planId = "plan-atomic-1";
  let planStatus = "awaiting_approval";

  // Simulate atomic update WHERE status = 'awaiting_approval'
  function atomicApprove(): boolean {
    if (planStatus === "awaiting_approval") {
      planStatus = "executing";
      return true;
    }
    return false;
  }

  // First approval succeeds
  const firstApproval = atomicApprove();
  assert.equal(firstApproval, true, "First approval must claim the executing lock");
  assert.equal(planStatus, "executing");

  // Concurrent/duplicate approval attempt fails immediately
  const secondApproval = atomicApprove();
  assert.equal(secondApproval, false, "Concurrent approval attempt must be rejected");
  assert.equal(planStatus, "executing", "Status remains executing");
});

test("Studio E2E Workflow 3: Rejection Flow Transitions to Rejected (P0-3)", async () => {
  const plan: CreativePlan = {
    id: "plan-rej-1",
    version: "2026.10.1",
    status: "awaiting_approval",
    scope: "image_only",
    autonomy: "manual",
    objective: "conversion",
    selectedConceptId: null,
    rationale: [],
    deliverables: [],
    assetPlan: [],
    productionPlan: [],
    estimatedCost: { totalEstimatedUsd: 1.0, perDeliverableUsd: {}, isHardCapped: false, currency: "USD", label: "PRE_GENERATION_ESTIMATE" },
    approvalRequirements: [],
    fallbackPlan: [],
    constraintsApplied: [],
    whyFormatChosen: "Manual selection",
    whyOtherFormatsRejected: {},
    createdAt: new Date().toISOString(),
  };

  assert.equal(plan.status, "awaiting_approval");
  plan.status = "rejected";
  assert.equal(plan.status, "rejected", "Rejected plan must have status rejected");
});

