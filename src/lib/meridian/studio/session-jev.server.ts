// The stored JEV decision that a studio plan is gated on. Moved out of studio/session.server.ts unchanged (coding loop, T4).

import type { Sql } from "../learning/store.ts";
import { evaluateJevGate } from "../jev/reviewer-decision.ts";
import { asText } from "./session-load.server.ts";

type StoredJevDecision = {
  id: string;
  decision: string;
  reviewer_decision: string | null;
  evidence: string;
  answer: string;
  subject_type: string;
  schema_version: string;
  model_response: string;
  provider: string;
  model: string;
  question_id: string;
  question_version: string;
  reasons: string;
  probability: number;
  confidence: number;
};

/**
 * Loads the JEV decision a brief was produced under and applies the centralized gate.
 * Fails closed: a missing decision id, a row that is absent from this tenant and brand,
 * a BLOCK, and a REQUIRE_HUMAN outcome all throw. Callers run it before any write or billable call.
 */
export async function loadGatedJevDecision(
  sql: Sql,
  organizationId: string,
  brandId: string,
  decisionId: unknown,
  subject: "brief" | "plan" = "brief",
): Promise<StoredJevDecision> {
  const id = asText(decisionId).trim();
  if (!id) {
    throw new Error(`${subject === "plan" ? "CreativePlan" : "Brief"} has no JEV decision. Creative production is refused before any provider call.`);
  }
  const rows = await sql<StoredJevDecision>`
    select id, decision, reviewer_decision, evidence, answer, subject_type, schema_version,
           model_response, provider, model, question_id, question_version, reasons, probability, confidence
    from jev_decisions
    where id = ${id} and organization_id = ${organizationId} and brand_id = ${brandId}
    limit 1
  `;
  const dec = rows[0];
  if (!dec) {
    throw new Error(`The JEV decision for this ${subject} was not found in this brand. Creative production is refused before any provider call.`);
  }
  // Enforce Decision Semantics via centralized evaluateJevGate (P0-2)
  const gate = evaluateJevGate({ decision: dec.decision, reviewerDecision: dec.reviewer_decision });
  if (gate.status === "BLOCK") {
    throw new Error(`JEV policy rejected this brief: ${gate.reason}. Creative production is blocked.`);
  }
  if (gate.status === "REQUIRE_HUMAN") {
    throw new Error("JEV requires recorded human review for this brief before production can proceed.");
  }
  return dec;
}
