import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import { assertReproducible, decisionRecordFields } from "../jev/decision-record.ts";
import type { Sql } from "../learning/store.ts";
import { ENGINE_REPLACED_MEDIA_QUESTIONS, judgeMedia } from "./features.ts";
import { writeJudgment } from "./session.server.ts";

const facts = {
  kind: "image" as const,
  positioning: "The point is the lather and the proof of a simple bar.",
  tone: "plain",
  prohibited: "",
  wordsToAvoid: "",
  productName: "Lather bar",
  angle: "lather_proof",
  copy: "Lather bar, shown in one take. No borrowed line.",
  prompt: "Still of Lather bar. Angle lather_proof.",
  competitorTexts: ["today only this exact line from a rival"],
  ownTexts: [],
  mime: "image/svg+xml",
  byteSize: 80,
  width: 64,
  height: 64,
  checksum: "abc123def4567890",
  durationMs: null,
  transcript: "",
  sceneCount: 0,
  logoSimilarity: null,
  paletteDistance: null,
  semanticSimilarity: null,
};

async function tenant(sql: Sql) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-dr-${suffix}`;
  const brandId = `brand-dr-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  return { organizationId, brandId, suffix };
}

test("every decision row a creative judgment writes carries the fingerprint and digest the same evidence reproduces", async () => {
  const sql = await getSql();
  const t = await tenant(sql);
  const creativeA = `creative-a-${t.suffix}`;
  const creativeB = `creative-b-${t.suffix}`;
  await writeJudgment(sql, { organizationId: t.organizationId, brandId: t.brandId, creativeId: creativeA, facts });
  await writeJudgment(sql, { organizationId: t.organizationId, brandId: t.brandId, creativeId: creativeB, facts });

  const rows = await sql<{ subject_id: string; question_id: string; decision_fingerprint: string; outcome_digest: string }>`
    select subject_id, question_id, decision_fingerprint, outcome_digest from jev_decisions
    where organization_id = ${t.organizationId} and brand_id = ${t.brandId}
  `;
  // The lexical brand and opportunity checks are decided by the engine gate, so they are not written locally.
  const expected = judgeMedia(facts).filter((decision) => !ENGINE_REPLACED_MEDIA_QUESTIONS.has(decision.questionId));
  assert.equal(rows.length, 2 * expected.length);
  for (const decision of expected) {
    const fields = decisionRecordFields(decision);
    const forA = rows.find((row) => row.subject_id === creativeA && row.question_id === decision.questionId);
    const forB = rows.find((row) => row.subject_id === creativeB && row.question_id === decision.questionId);
    assert.equal(forA?.decision_fingerprint, fields.decisionFingerprint, `${decision.questionId}: stored fingerprint`);
    assert.equal(forA?.outcome_digest, fields.outcomeDigest, `${decision.questionId}: stored digest`);
    // The same evidence for another subject is the same record, and its rerun is reproducible.
    assert.equal(forB?.decision_fingerprint, forA?.decision_fingerprint, `${decision.questionId}: other subject`);
    assertReproducible(
      { decisionFingerprint: forA!.decision_fingerprint, outcomeDigest: forA!.outcome_digest },
      { decisionFingerprint: forB!.decision_fingerprint, outcomeDigest: forB!.outcome_digest },
    );
  }
});
