/**
 * The one way a brief is written. Every brief-creation path calls `createGatedBrief`, which judges the brief with the shared
 * brief gate first and writes the brief row only afterwards. The rules are in docs/ARCHITECTURE_CONTRACTS.md, section 3.
 */
import { randomUUID } from "node:crypto";
import type { BrainSlice } from "../domain.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import type { EngineSelection } from "../decisions/selection.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { judgeBriefFit, writeBriefDecision, type BriefBrain, type BriefForGate, type BriefGateResult } from "./brief-gate.server.ts";
import { briefStatusFor } from "./brief-review.server.ts";
import type { CreateGatedBriefInput, CreateGatedBriefResult } from "./brief-service.contract.ts";

/** Engine selection for the gate. Production leaves it unset, so the workspace or deployment engine is used. Tests inject one. */
export type BriefGateOptions = { selection?: EngineSelection; engines?: DecisionEngineRegistry };

/**
 * The brand facts the brief gate reads. Both brief paths take them from the brand's loaded context, the same loader the
 * ranking reads, so the gate never judges against facts the paths did not load.
 */
export function briefBrainFrom(brain: BrainSlice): BriefBrain {
  return {
    positioning: brain.positioning,
    valueProposition: brain.valueProposition,
    tone: brain.tone,
    prohibitedClaims: brain.prohibitedClaims,
    wordsToAvoid: brain.wordsToAvoid,
  };
}

/**
 * The judge a path passes to `createGatedBrief`. It runs the shared `judgeBriefFit` with the brief's fields and the brand's
 * facts, so every path asks the same question of the same engine.
 */
export function briefGateJudge(
  sql: Sql,
  input: BriefGateOptions & { organizationId: string; brandId: string; brief: BriefForGate; brain: BriefBrain },
): (briefId: string) => Promise<BriefGateResult> {
  return (briefId) =>
    judgeBriefFit({
      sql,
      organizationId: input.organizationId,
      brandId: input.brandId,
      briefId,
      brief: input.brief,
      brain: input.brain,
      selection: input.selection,
      engines: input.engines,
    });
}

// The direction reason check lives in a file without server imports, so client code can use it.
export { directionReasonProblem } from "../opportunity/direction-reason.ts";

/**
 * Creates a brief through the gate, in the fixed order of contract section 3:
 *   1. reserve the brief id,
 *   2. judge the brief with the shared gate (the engine call; no transaction is open),
 *   3. in one transaction, write the decision and its gate record, insert the brief with the status its outcome gives,
 *      and mark the opportunity briefed unless the brief was rejected.
 * Only an AUTO_APPROVE outcome can produce a `ready` brief. Every other outcome is stored as `awaiting_review` or `rejected`.
 */
export async function createGatedBrief(sql: Sql, input: CreateGatedBriefInput): Promise<CreateGatedBriefResult> {
  const briefId = randomUUID();
  const decisionId = randomUUID();
  const result = await input.judge(briefId);
  const status = briefStatusFor(result.action);
  const brief = input.brief;
  return withTransaction(sql, async (tx) => {
    await writeBriefDecision(tx, { organizationId: input.organizationId, brandId: input.brandId, briefId, decisionId, result });
    await tx`
      insert into briefs (
        id, organization_id, brand_id, opportunity_id, title, audience, angle, hook, message, offer, cta,
        format, proof_type, constraints, context_pack, workflow, why, learning_notes, failure_notes,
        status, decision_id, created_by
      ) values (
        ${briefId}, ${input.organizationId}, ${input.brandId}, ${brief.opportunityId}, ${brief.title},
        ${brief.audience}, ${brief.angle}, ${brief.hook}, ${brief.message}, ${brief.offer}, ${brief.cta},
        ${brief.format}, ${brief.proofType}, ${brief.constraints}, ${JSON.stringify(brief.context)},
        ${JSON.stringify(brief.workflow)}, ${JSON.stringify(brief.why)}, ${JSON.stringify(brief.learningNotes)},
        ${JSON.stringify(brief.failureNotes)}, ${status}, ${decisionId}, ${input.createdBy}
      )
    `;
    if (status !== "rejected" && brief.opportunityId) {
      await tx`
        update opportunities set status = 'briefed'
        where id = ${brief.opportunityId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      `;
    }
    return { briefId, decisionId, action: result.action, status };
  });
}
