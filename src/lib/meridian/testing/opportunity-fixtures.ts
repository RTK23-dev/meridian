/**
 * Fixtures for brief creation and opportunity direction: a stored opportunity with its decision and review hold, a
 * competitor creative whose angle is not a prior hypothesis (so ranking discovers it), and a SQL wrapper that fails one
 * chosen write, for atomicity tests.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";

export type OpportunityOutcome = "AUTO_APPROVE" | "HUMAN_REVIEW" | "REJECT";

/** A stored opportunity with the decision it was given. A HUMAN_REVIEW opportunity also gets the open review hold. */
export async function seedOpportunity(
  sql: Sql,
  tenant: { organizationId: string; brandId: string },
  options: { outcome?: OpportunityOutcome; status?: string; angle?: string } = {},
): Promise<{ opportunityId: string; decisionId: string }> {
  const opportunityId = randomUUID();
  const decisionId = randomUUID();
  const outcome = options.outcome ?? "AUTO_APPROVE";
  const angle = options.angle ?? `observed_angle_${opportunityId.slice(0, 8)}`;
  await sql`
    insert into jev_decisions (
      id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
      input, evidence, probability, confidence, thresholds, decision, reasons
    ) values (
      ${decisionId}, ${tenant.organizationId}, ${tenant.brandId}, ${opportunityId}, 'opportunity_gate.v2', '2', 'opportunity',
      ${opportunityId}, '{}', '[]', 0.5, 0.5, '{}', ${outcome}, '[]'
    )
  `;
  await sql`
    insert into opportunities (
      id, organization_id, brand_id, hypothesis_id, label, category, angle, hook_type, audience, format, proof_type,
      product_name, market_signal, novelty_score, brand_fit_score, reproducibility_score, risk_score, saturation_score,
      historical_score, expected_value, raw_score, confidence, reason, evidence, evidence_basis, supporting_ids, status, decision_id
    ) values (
      ${opportunityId}, ${tenant.organizationId}, ${tenant.brandId}, ${`discovered:${angle}`}, ${`Observed angle: ${angle}`},
      'discovered', ${angle}, 'question', 'busy parents', 'video', 'demonstration', '', 0.4, 0.6, 0.7, 0.6, 0.2, 0.1, 0.3,
      0.5, 0.5, 0.6, 'Stored competitor creatives show this angle.', '[]', 'stored_creatives', '[]',
      ${options.status ?? "open"}, ${decisionId}
    )
  `;
  if (outcome === "HUMAN_REVIEW") {
    await sql`
      insert into reviews (id, organization_id, brand_id, decision_id, opportunity_id, subject_label)
      values (${randomUUID()}, ${tenant.organizationId}, ${tenant.brandId}, ${decisionId}, ${opportunityId}, 'Observed angle')
    `;
  }
  return { opportunityId, decisionId };
}

/** A competitor creative whose angle is not a prior hypothesis, so ranking discovers that angle for the brand. */
export async function seedCompetitorCreative(
  sql: Sql,
  tenant: { organizationId: string; brandId: string; userId: string },
  angle: string,
): Promise<void> {
  await sql`
    insert into creative_records (id, organization_id, brand_id, origin, angle, hook_type, format, proof_type, raw_text, title, created_by)
    values (${randomUUID()}, ${tenant.organizationId}, ${tenant.brandId}, 'competitor', ${angle}, 'question', 'video',
      'demonstration', ${`A competitor ad about ${angle.replaceAll("_", " ")}.`}, ${`Competitor ${angle}`}, ${tenant.userId})
  `;
}

/**
 * Wraps a Sql so that any statement whose text matches `pattern` throws, including statements inside a transaction. Every
 * other statement passes through unchanged. Used to fail one write at a time and check what was left behind.
 */
export function failingSql(base: Sql, pattern: RegExp, message = "injected write failure"): Sql {
  const wrap = (inner: Sql): Sql => {
    const guard = (text: string) => {
      if (pattern.test(text)) throw new Error(message);
    };
    const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      guard(strings.join("?"));
      return inner(strings, ...values);
    }) as unknown as Sql;
    tagged.query = (async (text: string, params?: unknown[]) => {
      guard(text);
      return inner.query(text, params);
    }) as Sql["query"];
    if (inner.begin) {
      const begin = inner.begin.bind(inner);
      tagged.begin = (<T>(fn: (tx: Sql) => Promise<T>) => begin<T>((tx) => fn(wrap(tx)))) as Sql["begin"];
    }
    return tagged;
  };
  return wrap(base);
}

/**
 * Brand facts the brief builder and the gate read. Without them a discovered brief has no audience and no message, and the
 * gate rejects it on its mandatory fields before any engine is asked. The prohibited claims are recorded, because claim
 * compliance is judged against them: a blank brand fact is not evidence, so that question would abstain and the brief would
 * go to review.
 */
export async function seedBrandBrain(sql: Sql, tenant: { brandId: string; userId: string }): Promise<void> {
  await sql`
    insert into brand_brains (brand_id, target_customers, positioning, value_proposition, tone, prohibited_claims, updated_by)
    values (${tenant.brandId}, 'Busy parents', 'Helps busy parents plan a calm dinner in ten minutes.',
      'Planned dinners with no planning.', 'warm', 'guaranteed', ${tenant.userId})
  `;
}

/** Adds a signed-in user to the tenant with a role, for tests that need an admin, a member or a viewer. */
export async function addMember(
  sql: Sql,
  tenant: { organizationId: string },
  role: "viewer" | "member" | "admin" | "owner",
): Promise<string> {
  const userId = `user-${role}-${randomUUID()}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@fixture.example`}, true)`;
  await sql`
    insert into memberships (id, organization_id, user_id, role)
    values (${randomUUID()}, ${tenant.organizationId}, ${userId}, ${role})
  `;
  return userId;
}
