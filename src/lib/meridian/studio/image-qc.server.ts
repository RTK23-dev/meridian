/**
 * Quality judgment for generated images. The studio and the durable production materializer both judge an image with
 * these functions, so a judgment is made from the stored bytes and the brand's own data, in one place.
 */
import type { Sql } from "../learning/store.ts";
import type { loadBrandContext } from "../context/load.ts";

/**
 * The brand data a judgment compares an image against. It is captured when the image is submitted, so the judgment is the
 * same whenever it is made: a sibling image created later in the same run is never part of the comparison.
 */
export type QcBrandContext = {
  brain: { positioning: string; valueProposition: string; tone: string; prohibitedClaims: string; wordsToAvoid: string };
  creatives: Array<{ origin: string; text: string }>;
};

export function qcBrandOf(loaded: Awaited<ReturnType<typeof loadBrandContext>>): QcBrandContext {
  return {
    brain: {
      positioning: loaded.brain.positioning,
      valueProposition: loaded.brain.valueProposition,
      tone: loaded.brain.tone,
      prohibitedClaims: loaded.brain.prohibitedClaims,
      wordsToAvoid: loaded.brain.wordsToAvoid,
    },
    creatives: loaded.creatives.map((item) => ({ origin: item.origin, text: item.text })),
  };
}
import { decisionRecordFields } from "../jev/decision-record.ts";
import { loadAppliedPolicies } from "../jev/policy.ts";
import { judgeMedia, rollupDecision, type MediaFacts } from "./features.ts";
import type { AccountSnapshot } from "../publishing/readiness.ts";
import { measureLogo, measurePalette } from "../vision/measure.ts";

export async function visualFacts(sql: Sql, organizationId: string, brandId: string, bytes: Uint8Array) {
  const logos = await sql<{ body: string }>`
    select body from assets
    where brand_id = ${brandId} and organization_id = ${organizationId} and label = 'logo' and status = 'stored'
    order by created_at desc
    limit 1
  `;
  const colors = await sql<{ colors: string }>`
    select colors from brand_brains where brand_id = ${brandId} limit 1
  `;
  const logo = logos[0]?.body ? Buffer.from(logos[0].body, "base64") : null;
  const measuredLogo = measureLogo(logo, bytes);
  const measuredPalette = measurePalette(colors[0]?.colors ?? "", bytes);
  return { measuredLogo, measuredPalette };
}

export async function accountSnapshots(sql: Sql, organizationId: string): Promise<AccountSnapshot[]> {
  const rows = await sql<{ provider: string; status: string; account_id: string; permissions: string }>`
    select provider, status, account_id, permissions from provider_connections
    where organization_id = ${organizationId}
  `;
  return rows.map((row) => {
    let permissions: string[] = [];
    try {
      const parsed = JSON.parse(row.permissions) as unknown;
      permissions = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      permissions = [];
    }
    return {
      provider: row.provider,
      status: row.status,
      accountId: row.account_id,
      permissions,
      pageId: "",
      destinationUrl: "",
    };
  });
}

export function competitorCopy(loaded: QcBrandContext): string[] {
  return loaded.creatives.filter((item) => item.origin === "competitor").map((item) => item.text);
}

export function factsFor(
  loaded: QcBrandContext,
  input: Omit<MediaFacts, "positioning" | "tone" | "prohibited" | "wordsToAvoid" | "competitorTexts" | "ownTexts">,
): MediaFacts {
  return {
    ...input,
    positioning: `${loaded.brain.positioning}\n${loaded.brain.valueProposition}`,
    tone: loaded.brain.tone,
    prohibited: loaded.brain.prohibitedClaims,
    wordsToAvoid: loaded.brain.wordsToAvoid,
    competitorTexts: loaded.creatives.filter((item) => item.origin === "competitor").map((item) => item.text),
    ownTexts: loaded.creatives.filter((item) => item.origin !== "competitor").map((item) => item.text),
  };
}

export async function writeJudgment(
  sql: Sql,
  input: { organizationId: string; brandId: string; creativeId: string; facts: MediaFacts },
): Promise<{ rollup: string; decisionId: string }> {
  const policies = await loadAppliedPolicies(sql, input.organizationId);
  const decisions = judgeMedia(input.facts, policies);
  const rollup = rollupDecision(decisions);
  let pointed = "";
  for (const decision of decisions) {
    // Deterministic per creative and question, so a retried judgment cannot record the same decision twice.
    const id = `${input.creativeId}:${decision.questionId}`;
    if (!pointed && decision.decision === rollup) pointed = id;
    const record = decisionRecordFields(decision);
    await sql`
      insert into jev_decisions (
        id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
        input, evidence, probability, confidence, thresholds, decision, reasons, provider, model,
        answer, schema_version, policy_version, calibration_version, decision_fingerprint, outcome_digest
      ) values (
        ${id}, ${input.organizationId}, ${input.brandId}, ${input.creativeId}, ${decision.questionId},
        ${decision.questionVersion}, 'creative', ${input.creativeId}, ${JSON.stringify(decision.features)},
        ${JSON.stringify(decision.evidence)}, ${decision.probability}, ${decision.confidence},
        ${JSON.stringify(decision.policy)}, ${decision.decision}, ${JSON.stringify(decision.reasons)},
        ${decision.provider}, ${decision.modelVersion},
        ${JSON.stringify(decision.answer)}, ${decision.schemaVersion}, ${decision.policyVersion}, ${decision.calibrationVersion ?? ""},
        ${record.decisionFingerprint}, ${record.outcomeDigest}
      )
      on conflict (id) do nothing
    `;
  }
  return { rollup, decisionId: pointed };
}
