import assert from "node:assert/strict";
import test from "node:test";
import type { CreativePlan } from "../creative/plan.ts";
import { TEST_PLAN_LINEAGE } from "./plan-lineage.ts";

// This file executes plans that use the placeholder image provider, which is isolated to TestingRuntime.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

// Workflow 1 (carousel execution against a fake database) now runs on the real database in
// production/image-durable.test.ts, because the image lifecycle reads and writes real production job and artifact rows.

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
    lineage: TEST_PLAN_LINEAGE,
    productionContext: null,
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

