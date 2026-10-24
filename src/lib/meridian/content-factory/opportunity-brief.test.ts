// An opportunity becomes a Content Factory brief: a draft session titled with the idea, whose first message is the idea's own stored brief, and
// the idea is marked briefed. These tests run the real service on PGlite. The brief's text and its evidence reading are checked on their own.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { briefFromOpportunity } from "./service.ts";
import { briefTextOf, evidenceSummariesOf } from "./opportunity-brief.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";

const WS = "ws_opp_brief";
const BRAND = "brand_opp_brief";
const OTHER_WS = "ws_opp_brief_other";
const OTHER_BRAND = "brand_opp_brief_other";
const ADMIN = "user_opp_admin";
const MEMBER = "user_opp_member";
const OPEN_IDEA = "opp_open_1";
const DECLINED_IDEA = "opp_rejected_1";
const UNREAD_IDEA = "opp_needs_research_1";
const OTHER_IDEA = "opp_other_1";

const EVIDENCE = JSON.stringify([
  { id: "ev_1", source: "ads", summary: "Three competitor ads open with the same kitchen problem" },
  { id: "ev_2", source: "research", summary: "Hook held attention for the first two seconds in the sample" },
]);

let db: TestDatabase;

async function insertIdea(sql: TestDatabase["sql"], id: string, workspace: string, brand: string, status: string, label: string): Promise<void> {
  await sql`
    insert into opportunities (id, organization_id, brand_id, hypothesis_id, label, category, angle, hook_type, audience, format, proof_type,
      product_name, market_signal, novelty_score, brand_fit_score, reproducibility_score, risk_score, saturation_score, historical_score,
      expected_value, raw_score, confidence, reason, evidence, evidence_basis, status)
    values (${id}, ${workspace}, ${brand}, ${`hyp_${id}`}, ${label}, 'hook', 'Fix the sticky pan in under a minute', 'problem', 'home cooks',
      'reel', 'before and after', 'Ceramic pan', 0.6, 0.5, 0.7, 0.6, 0.2, 0.3, 0.4, 0.55, 0.5, 0.6, 'Strong brand fit and a proven problem',
      ${EVIDENCE}, 'evidence_backed', ${status})
  `;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await seedWorkspace(db.sql, OTHER_WS, OTHER_BRAND);
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${ADMIN}, ${ADMIN}, ${`${ADMIN}@fixture.example`}, true)`;
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${MEMBER}, ${MEMBER}, ${`${MEMBER}@fixture.example`}, true)`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${ADMIN}`}, ${WS}, ${ADMIN}, 'admin')`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${MEMBER}`}, ${WS}, ${MEMBER}, 'member')`;
  await insertIdea(db.sql, OPEN_IDEA, WS, BRAND, "open", "Sticky pan fix");
  await insertIdea(db.sql, DECLINED_IDEA, WS, BRAND, "rejected", "Declined idea");
  await insertIdea(db.sql, UNREAD_IDEA, WS, BRAND, "needs_research", "Unread idea");
  await insertIdea(db.sql, OTHER_IDEA, OTHER_WS, OTHER_BRAND, "open", "Another workspace's idea");
});

after(async () => {
  await db.close();
});

describe("an opportunity becomes a Content Factory brief", () => {
  test("a draft session is made from the idea, titled with it, and its first message is the idea's brief; the idea is marked briefed", async () => {
    const made = await briefFromOpportunity(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, opportunityId: OPEN_IDEA });
    assert.equal(made.created, true);
    const sessions = await db.sql<{ title: string; status: string; opportunity_id: string }>`
      select title, status, opportunity_id from content_factory_sessions where id = ${made.sessionId} and organization_id = ${WS}
    `;
    assert.equal(sessions[0]?.title, "Sticky pan fix");
    assert.equal(sessions[0]?.status, "draft", "the session is a draft: the person still reviews the brief and starts the run");
    assert.equal(sessions[0]?.opportunity_id, OPEN_IDEA, "the session keeps the idea it was made from");
    const messages = await db.sql<{ text: string }>`select text from content_factory_messages where session_id = ${made.sessionId} order by created_at asc`;
    assert.equal(messages.length, 1);
    assert.match(messages[0]?.text ?? "", /^Idea: Sticky pan fix/);
    assert.match(messages[0]?.text ?? "", /Angle: Fix the sticky pan in under a minute/);
    assert.match(messages[0]?.text ?? "", /Why this idea: Strong brand fit and a proven problem/);
    assert.match(messages[0]?.text ?? "", /- Three competitor ads open with the same kitchen problem/);
    const idea = await db.sql<{ status: string }>`select status from opportunities where id = ${OPEN_IDEA} and organization_id = ${WS}`;
    assert.equal(idea[0]?.status, "briefed", "the idea is marked briefed, the status the Studio's brief uses too");
  });

  test("a second brief from the same idea returns the draft already made, and posts no second message", async () => {
    const first = await db.sql<{ id: string }>`select id from content_factory_sessions where opportunity_id = ${OPEN_IDEA} and organization_id = ${WS}`;
    const again = await briefFromOpportunity(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, opportunityId: OPEN_IDEA });
    assert.equal(again.created, false);
    assert.equal(again.sessionId, first[0]?.id);
    const count = await db.sql<{ n: number }>`select count(*)::int as n from content_factory_messages where session_id = ${again.sessionId}`;
    assert.equal(count[0]?.n, 1, "a double click makes nothing new");
  });

  test("a rejected idea and an idea not yet researched are refused, and no session is written", async () => {
    await assert.rejects(briefFromOpportunity(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, opportunityId: DECLINED_IDEA }), /no brief can be made/);
    await assert.rejects(briefFromOpportunity(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, opportunityId: UNREAD_IDEA }), /no brief can be made/);
    const written = await db.sql<{ n: number }>`
      select count(*)::int as n from content_factory_sessions where opportunity_id in (${DECLINED_IDEA}, ${UNREAD_IDEA})
    `;
    assert.equal(written[0]?.n, 0);
  });

  test("an idea of another workspace is not in this brand, so nothing is made from it", async () => {
    await assert.rejects(briefFromOpportunity(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, opportunityId: OTHER_IDEA }), /not in this brand/);
    await assert.rejects(briefFromOpportunity(db.sql, ADMIN, { organizationId: WS, brandId: OTHER_BRAND, opportunityId: OTHER_IDEA }), /not available|not in this workspace|workspace/i);
  });

  test("a member who is not an admin makes no brief", async () => {
    await assert.rejects(briefFromOpportunity(db.sql, MEMBER, { organizationId: WS, brandId: BRAND, opportunityId: OPEN_IDEA }), /admin/i);
  });
});

describe("the brief's text", () => {
  test("it carries the idea's stored fields, leaves out an empty one, and names at most five evidence summaries", () => {
    const text = briefTextOf({
      label: "  Sticky pan   fix ",
      angle: "Fix the pan",
      hookType: "",
      audience: "home cooks",
      format: "reel",
      proofType: "",
      productName: "Ceramic pan",
      reason: "Proven",
      evidence: [1, 2, 3, 4, 5, 6].map((index) => ({ summary: `Evidence ${index}` })),
    });
    assert.equal(text.split("\n")[0], "Idea: Sticky pan fix", "whitespace is collapsed");
    assert.ok(!text.includes("Hook:"), "an empty field is left out");
    assert.ok(!text.includes("Proof:"), "an empty field is left out");
    assert.match(text, /Audience: home cooks/);
    assert.equal((text.match(/^- /gm) ?? []).length, 5, "at most five evidence summaries");
  });

  test("a long field is clipped, and it adds nothing that was not stored", () => {
    const text = briefTextOf({ label: "x", angle: "a".repeat(1000), hookType: "", audience: "", format: "", proofType: "", productName: "", reason: "", evidence: [] });
    const angle = text.split("\n").find((line) => line.startsWith("Angle: "));
    assert.ok(angle && angle.length <= "Angle: ".length + 400);
    assert.ok(angle?.endsWith("…"));
    assert.ok(!text.includes("Evidence:"), "no evidence heading without evidence");
  });

  test("stored evidence that is not a list of summaries reads as none, never as a guess", () => {
    assert.deepEqual(evidenceSummariesOf("not json"), []);
    assert.deepEqual(evidenceSummariesOf('{"summary":"x"}'), []);
    assert.deepEqual(evidenceSummariesOf('[{"id":"ev","source":"ads"},null,{"summary":"kept"}]'), [{ summary: "kept" }]);
  });
});
