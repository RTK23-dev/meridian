import type { PlanLineage } from "../creative/lineage.ts";
import type { PlanProductionContext } from "../creative/plan.ts";

/**
 * Lineage for tests that build creative plans directly. Production plans take their lineage from the gated JEV
 * decision (studio/session.server.ts), never from this constant.
 */
export const TEST_PLAN_LINEAGE: PlanLineage = { decisionId: "jev-test-decision", evidenceRefs: ["ev-test-1"] };

/**
 * The production context for tests that build plans directly. Production plans take their snapshot from the brief at
 * planning time (studio/session.server.ts), never from this constant.
 */
export const TEST_PRODUCTION_CONTEXT: PlanProductionContext = {
  title: "Kitchen sponge",
  audience: "Adults with dry hands",
  angle: "live demonstration",
  productName: "Mesh sponge",
  opportunityId: null,
};
