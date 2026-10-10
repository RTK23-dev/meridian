/**
 * Creates a brief through the shared brief gate. This is the only path that writes a brief row
 * (docs/ARCHITECTURE_CONTRACTS.md, section 3).
 *
 * The order is fixed. The brief id is reserved, then the gate judges the brief with no transaction open, because the judgment
 * may call an engine. Then one transaction writes the decision with its gate record, the brief row with the status its outcome
 * gives, and the opportunity's briefed mark unless the brief was rejected. A brief the engine could not judge is stored as
 * awaiting_review, and creating it approves nothing.
 */
import { randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import { writeBriefDecision } from "./brief-gate.server.ts";
import { briefStatusFor } from "./brief-review.server.ts";
import type { CreateGatedBriefInput, CreateGatedBriefResult } from "./brief-service.contract.ts";

export async function createGatedBrief(sql: Sql, input: CreateGatedBriefInput): Promise<CreateGatedBriefResult> {
  const { brief } = input;
  const briefId = randomUUID();
  const decisionId = randomUUID();
  const result = await input.judge(briefId);
  const status = briefStatusFor(result.action);
  await withTransaction(sql, async (tx) => {
    await writeBriefDecision(tx, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      briefId,
      decisionId,
      result,
    });
    await tx`
      insert into briefs (
        id, organization_id, brand_id, opportunity_id, title, audience, angle, hook, message, offer, cta,
        format, proof_type, constraints, context_pack, workflow, why, learning_notes, failure_notes,
        status, decision_id, created_by
      ) values (
        ${briefId}, ${input.organizationId}, ${input.brandId}, ${brief.opportunityId}, ${brief.title},
        ${brief.audience}, ${brief.angle}, ${brief.hook}, ${brief.message}, ${brief.offer}, ${brief.cta},
        ${brief.format}, ${brief.proofType}, ${String(brief.constraints ?? "")}, ${JSON.stringify(brief.context)},
        ${JSON.stringify(brief.workflow)}, ${JSON.stringify(brief.why)}, ${JSON.stringify(brief.learningNotes)},
        ${JSON.stringify(brief.failureNotes)}, ${status}, ${decisionId}, ${input.createdBy}
      )
    `;
    if (brief.opportunityId && result.action !== "REJECT") {
      await tx`
        update opportunities set status = 'briefed'
        where id = ${brief.opportunityId} and brand_id = ${input.brandId} and organization_id = ${input.organizationId}
      `;
    }
  });
  return { briefId, decisionId, action: result.action, status };
}
