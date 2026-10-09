import type { PlanLineage } from "../creative/lineage.ts";

/**
 * Lineage for tests that build creative plans directly. Production plans take their lineage from the gated JEV
 * decision (studio/session.server.ts), never from this constant.
 */
export const TEST_PLAN_LINEAGE: PlanLineage = { decisionId: "jev-test-decision", evidenceRefs: ["ev-test-1"] };
