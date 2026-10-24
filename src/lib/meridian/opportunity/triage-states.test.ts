// Triage states (prompt 13): save, defer and request more research hold an open idea out of the list with a reason; reopen returns it. The
// rules and the status each action leaves are pure and tested first. Then, on PGlite with every migration, each action writes its status,
// its decision row and its audit line, a held idea is kept out of the next refresh, and a refused action changes nothing.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { isDirectionAction, sourceStatusProblem, statusAfter, triageActionsFor } from "./triage-states.ts";
import { fingerprintKey, priorIdeaFor, priorIdeasByFingerprint, type PriorIdea } from "./triage-memory.ts";
import { readPriorIdeas } from "./triage-memory-store.ts";

// The decision path imports modules that use the "@/" alias, so the alias hook is registered before it is loaded.
enableAppAliases();
const { recordOpportunityDirection } = await import("./actions.ts");

const WS = "org_triage_states";
const BRAND = "brand_triage_states";
const MEMBER = "user_triage_member";
const VIEWER = "user_triage_viewer";
const REASON = "This idea repeats the lather demo the brand already ran last quarter.";

test("each action leaves a fixed status, and a held status can only be reopened", () => {
  assert.equal(statusAfter("approve"), "accepted");
  assert.equal(statusAfter("decline"), "dismissed");
  assert.equal(statusAfter("save"), "saved");
  assert.equal(statusAfter("defer"), "deferred");
  assert.equal(statusAfter("request_research"), "needs_research");
  assert.equal(statusAfter("reopen"), "open");
  assert.equal(isDirectionAction("save"), true);
  assert.equal(isDirectionAction("archive"), false);
  assert.equal(sourceStatusProblem("save", "open"), null);
  assert.match(sourceStatusProblem("save", "saved") ?? "", /Only an open idea/);
  assert.equal(sourceStatusProblem("reopen", "deferred"), null);
  assert.match(sourceStatusProblem("reopen", "open") ?? "", /Only a saved, deferred or needs-research/);
  assert.match(sourceStatusProblem("approve", "saved") ?? "", /already briefed/, "a held idea is not approved from the list");
  assert.equal(sourceStatusProblem("decline", "accepted"), null, "an accepted idea can still be declined before its brief");
});

test("the screen offers the triage actions a status allows, and nothing for a finished one", () => {
  assert.deepEqual(triageActionsFor("open"), ["decline", "save", "defer", "request_research"]);
  assert.deepEqual(triageActionsFor("accepted"), ["decline"]);
  assert.deepEqual(triageActionsFor("saved"), ["reopen"]);
  assert.deepEqual(triageActionsFor("deferred"), ["reopen"]);
  assert.deepEqual(triageActionsFor("needs_research"), ["reopen"]);
  assert.deepEqual(triageActionsFor("briefed"), []);
  assert.deepEqual(triageActionsFor("rejected"), []);
});

test("a held idea is a prior idea, and it loses to an explored one for the same fingerprint", () => {
  const base = { hypothesisId: "hyp", productId: null, angle: "lather", format: "short_ugc", label: "Lather", reason: null, decidedAt: null };
  const held: PriorIdea = { ...base, opportunityId: "o_held", outcome: "held", decidedAt: "2026-10-01T00:00:00.000Z" };
  const explored: PriorIdea = { ...base, opportunityId: "o_explored", outcome: "explored" };
  const declined: PriorIdea = { ...base, opportunityId: "o_declined", outcome: "declined", decidedAt: "2026-10-09T00:00:00.000Z" };
  const key = fingerprintKey(base);
  assert.equal(priorIdeaFor(base, priorIdeasByFingerprint([declined, held]))?.outcome, "held", "a held idea wins over a declined one");
  assert.equal(priorIdeaFor(base, priorIdeasByFingerprint([declined, held, explored]))?.outcome, "explored", "explored wins over held and declined");
  assert.equal(priorIdeasByFingerprint([held]).get(key)?.outcome, "held");
});

let db: TestDatabase;

async function insertOpportunity(id: string, status: string): Promise<void> {
  await db.sql`
    insert into opportunities (id, organization_id, brand_id, hypothesis_id, label, category, angle, hook_type, format,
      market_signal, novelty_score, brand_fit_score, reproducibility_score, risk_score, saturation_score, historical_score,
      expected_value, raw_score, confidence, reason, evidence, evidence_basis, status)
    values (${id}, ${WS}, ${BRAND}, 'hyp_triage', ${`Idea ${id}`}, 'hook', 'lather', 'question', 'short_ugc',
      0.5, 0.5, 0.5, 0.5, 0.2, 0.2, 0.5, 0.5, 0.5, 0.5, 'fixture reason', 'fixture evidence', 'market', ${status})
  `;
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db.sql<{ status: string }>`select status from opportunities where id = ${id}`;
  return row?.status ?? "missing";
}

function direction(opportunityId: string, action: string, actorId = MEMBER, actorRole = "member", reason = REASON) {
  return recordOpportunityDirection(db.sql, {
    organizationId: WS,
    brandId: BRAND,
    opportunityId,
    actorId,
    actorRole,
    action: action as Parameters<typeof recordOpportunityDirection>[1]["action"],
    reason,
  });
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  for (const [id, role] of [[MEMBER, "member"], [VIEWER, "viewer"]] as const) {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${id}`}, ${WS}, ${id}, ${role})`;
  }
  for (const id of ["opp_save", "opp_defer", "opp_research", "opp_reopen", "opp_decline", "opp_viewer", "opp_short", "opp_brief"]) {
    await insertOpportunity(id, "open");
  }
  await db.sql`update opportunities set status = 'briefed' where id = 'opp_brief'`;
});

after(async () => {
  await db.close();
});

test("save keeps an idea out of the open list, with its reason and an audit line", async () => {
  const result = await direction("opp_save", "save");
  assert.equal(result.opportunityStatus, "saved");
  assert.equal(await statusOf("opp_save"), "saved", "the database accepts the new status");
  const [decision] = await db.sql<{ action: string; reason: string }>`select action, reason from opportunity_direction_decisions where opportunity_id = 'opp_save'`;
  assert.equal(decision?.action, "save");
  assert.equal(decision?.reason, REASON);
  const audits = await db.sql<{ action: string }>`select action from audit_log where object_id = 'opp_save' and action = 'opportunity.direction.save'`;
  assert.equal(audits.length, 1, "one audit line for the save");
});

test("a saved idea reads as held, so a refresh does not put it back as new", async () => {
  const prior = await readPriorIdeas(db.sql, WS, BRAND);
  const idea = prior.find((item) => item.opportunityId === "opp_save");
  assert.equal(idea?.outcome, "held");
  assert.equal(idea?.reason, REASON);
  const draft = { hypothesisId: "hyp_triage", productId: null, angle: "lather", format: "short_ugc" };
  assert.ok(priorIdeaFor(draft, priorIdeasByFingerprint(prior.filter((item) => item.opportunityId === "opp_save"))), "the same fingerprint is matched");
});

test("defer and request more research each leave their own status", async () => {
  assert.equal((await direction("opp_defer", "defer")).opportunityStatus, "deferred");
  assert.equal(await statusOf("opp_defer"), "deferred");
  assert.equal((await direction("opp_research", "request_research")).opportunityStatus, "needs_research");
  assert.equal(await statusOf("opp_research"), "needs_research");
});

test("reopen returns a held idea to the open list, and the decision is recorded", async () => {
  const result = await direction("opp_reopen", "save");
  assert.equal(result.opportunityStatus, "saved");
  assert.equal((await direction("opp_reopen", "reopen", MEMBER, "member", "The evidence for it is now in the Market view.")).opportunityStatus, "open");
  assert.equal(await statusOf("opp_reopen"), "open");
  const [decision] = await db.sql<{ count: string }>`select count(*)::text as count from opportunity_direction_decisions where opportunity_id = 'opp_reopen' and action = 'reopen'`;
  assert.equal(decision?.count, "1");
});

test("decline still dismisses an open idea, and a dismissed idea reads as declined", async () => {
  assert.equal((await direction("opp_decline", "decline")).opportunityStatus, "dismissed");
  const prior = await readPriorIdeas(db.sql, WS, BRAND);
  assert.equal(prior.find((item) => item.opportunityId === "opp_decline")?.outcome, "declined");
});

test("refusals change nothing: a viewer, a short reason, a hold on a briefed idea, reopen of an open one, and approve of a held one", async () => {
  await assert.rejects(direction("opp_viewer", "save", VIEWER, "viewer"), /member/);
  assert.equal(await statusOf("opp_viewer"), "open");

  await assert.rejects(direction("opp_short", "defer", MEMBER, "member", "too short"), /reason|characters|least/i);
  assert.equal(await statusOf("opp_short"), "open");

  await assert.rejects(direction("opp_brief", "save"), /Only an open idea/);
  assert.equal(await statusOf("opp_brief"), "briefed");

  await assert.rejects(direction("opp_reopen", "reopen"), /Only a saved, deferred or needs-research/);
  await assert.rejects(direction("opp_defer", "approve"), /already briefed/);
  assert.equal(await statusOf("opp_defer"), "deferred", "the approve refusal left the held idea held");

  await assert.rejects(direction("opp_save", "archive"), /Choose approve, decline, save, defer, request more research or reopen/);
});
