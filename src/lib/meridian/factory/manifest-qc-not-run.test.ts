import assert from "node:assert/strict";
import test from "node:test";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import { manifestFromCreativePlan } from "./creative-manifest.ts";
import { TEST_PLAN_LINEAGE } from "../testing/plan-lineage.ts";

test("a manifest built from a plan reports QC as pending with no check claimed as passed", () => {
  const plan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    scope: "image_only",
    autonomy: "semi_automatic",
    preferredImageProvider: "test:image",
    brief: {
      title: "Kitchen sponge",
      hook: "Tired of smelly sponges?",
      message: "Swipe to see the antibacterial mesh layer",
      cta: "Grab a 4-pack today",
      angle: "live demonstration",
      productName: "Mesh sponge",
      aspectRatio: "9:16",
      decisionId: "jev-qc-fixture",
    },
    constraints: {},
  });
  const manifest = manifestFromCreativePlan(plan, plan.deliverables[0]!, { organizationId: "org-qc", brandId: "brand-qc" });

  assert.equal(manifest.qc.status, "PENDING");
  assert.deepEqual(manifest.qc.checks, {}, "no check has run, so none may be recorded as true");
  assert.ok(
    Object.values(manifest.qc.checks).every((value) => value !== true),
    "no QC flag may read as passed while QC is pending",
  );
});
