// Choosing a cookbook for a draft run (K18a), on PGlite: the run's inputs come from the session; a choice is recorded on a draft; a choice the
// inputs do not allow is refused; a started run keeps its record; a member cannot choose (the session is the admin's to run).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { cookbookSelectionOf } from "../cookbooks/run-record.ts";
import { DIRECTION_CODEX_VERSION } from "../direction/codex.ts";
import { applyRecordedCookbook, chooseCookbookFor, proposalForRunFor, runInputsOf } from "./cookbook-choice.ts";
import type { RequestBuild } from "./request.ts";
import { sessionAccess } from "./service-core.ts";
import type { Attachment } from "./model.ts";
import { createSession, saveSettings } from "./service-sessions.ts";

const ORG = "org_cookbook_choice";
const BRAND = "brand_cookbook_choice";
const ADMIN = "user_choice_admin";
const MEMBER = "user_choice_member";
let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${ADMIN}, ${ADMIN}, ${`${ADMIN}@fixture.example`}, true)`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${ADMIN}`}, ${ORG}, ${ADMIN}, 'admin')`;
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${MEMBER}, ${MEMBER}, ${`${MEMBER}@fixture.example`}, true)`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${MEMBER}`}, ${ORG}, ${MEMBER}, 'member')`;
});

after(async () => {
  await db.close();
});

async function draftWithLength(seconds: number | null): Promise<string> {
  const summary = await createSession(db.sql, ADMIN, { organizationId: ORG, brandId: BRAND, title: "Choice run" });
  await saveSettings(db.sql, ADMIN, { sessionId: summary.id, budgetUsd: null, maxSeconds: seconds, language: null, priority: null, keepGenes: [] });
  return summary.id;
}

const FILE: Attachment = {
  id: "att_1",
  kind: "file",
  messageId: "msg_1",
  purpose: "reference_video",
  fileName: "ref.mp4",
  storageObjectId: null,
  storageKey: "store/ref.mp4",
  mediaType: "video/mp4",
} as unknown as Attachment;

test("the run's inputs are read from the session: the brief, a reference, the uploads and the budget", () => {
  const inputs = runInputsOf({
    budgetUsd: 25,
    messages: [
      { text: "Show the lots", beatRole: null, attachments: [FILE] },
      { text: "Hook", beatRole: "hook", attachments: [] },
    ],
  });
  assert.equal(inputs.briefChars, "Show the lots".length, "only the brief counts, not the scripted beats");
  assert.equal(inputs.reference.attached, true);
  assert.equal(inputs.reference.dnaCached, false, "the cached DNA is not known here, so it is false");
  assert.equal(inputs.productKit, false, "a product kit is not read here, so it is not available");
  assert.equal(inputs.budgetUsd, 25);
});

test("a draft run with the length set records the person's choice, from the eligible list when no selector is connected", async () => {
  const id = await draftWithLength(60);
  const outcome = await chooseCookbookFor(db.sql, { userId: ADMIN, sessionId: id, choice: { cookbookId: "ck_3d_data_explainer", version: 2 } });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  const stored = await cookbookSelectionOf(db.sql, { organizationId: ORG, sessionId: id });
  assert.equal(stored?.cookbookId, "ck_3d_data_explainer");
  assert.equal(stored?.how, "picked");
  assert.equal(stored?.proposedCookbookId, null);
});

test("a cookbook the inputs do not allow is refused, and nothing is recorded", async () => {
  const id = await draftWithLength(60);
  const outcome = await chooseCookbookFor(db.sql, { userId: ADMIN, sessionId: id, choice: { cookbookId: "ck_ugc_product", version: 1 } });
  assert.equal(outcome.ok, false);
  assert.equal(await cookbookSelectionOf(db.sql, { organizationId: ORG, sessionId: id }), null);
});

test("without a length the choice is refused, with the reason in words", async () => {
  const id = await draftWithLength(null);
  const outcome = await chooseCookbookFor(db.sql, { userId: ADMIN, sessionId: id, choice: { cookbookId: "ck_3d_data_explainer", version: 2 } });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /Set the length/);
});

test("a started run keeps its record: the choice is refused", async () => {
  const id = await draftWithLength(60);
  await db.sql`insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state) values ('req_choice_started', ${ORG}, ${BRAND}, 'ref_choice', 'normal', 'running', '{}')`;
  await db.sql`update content_factory_sessions set status = 'started', engine_request_id = 'req_choice_started', started_at = now() where id = ${id}`;
  const outcome = await chooseCookbookFor(db.sql, { userId: ADMIN, sessionId: id, choice: { cookbookId: "ck_3d_data_explainer", version: 2 } });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /already started/);
});

test("a member cannot choose a cookbook for a run: the session is the admin's to run", async () => {
  const id = await draftWithLength(60);
  await assert.rejects(chooseCookbookFor(db.sql, { userId: MEMBER, sessionId: id, choice: { cookbookId: "ck_3d_data_explainer", version: 2 } }));
});

const BASE_BUILD: RequestBuild = {
  status: "incomplete",
  candidate: {
    schema: "meridian.production_request/v1",
    requestId: "req_01HZX3K9M0Q7V8W6Y5T4R3E2D1",
    workspaceId: ORG,
    format: { formatId: "ref_abc", referenceVideo: "store://ref/1.mp4", keep: [], change: [] },
    brief: { text: "Show the parking lots.", sources: [], attachments: [] },
    visualRequests: [],
    page: { pageId: "page_1", styleKitId: "sk_theme", voiceId: "voice_1" },
    constraints: { aspect: "9:16", maxMs: 90000, budgetUsd: 20, priority: "normal" },
    output: { master: true },
  },
  problems: [],
};

test("a draft run with no recorded cookbook gets its request back unchanged", async () => {
  const id = await draftWithLength(60);
  const row = await sessionAccess(db.sql, ADMIN, id);
  const applied = await applyRecordedCookbook(db.sql, row, BASE_BUILD);
  assert.equal(applied, BASE_BUILD);
});

test("a recorded cookbook is applied to the request: its style replaces the page's kit and its reference joins the request", async () => {
  const id = await draftWithLength(60);
  const chosen = await chooseCookbookFor(db.sql, { userId: ADMIN, sessionId: id, choice: { cookbookId: "ck_3d_data_explainer", version: 2 } });
  assert.equal(chosen.ok, true);
  const row = await sessionAccess(db.sql, ADMIN, id);
  const applied = await applyRecordedCookbook(db.sql, row, BASE_BUILD);
  assert.equal(applied.status, "ready", applied.status === "incomplete" ? applied.problems.join("; ") : "");
  if (applied.status !== "ready") return;
  assert.equal(applied.request.page.styleKitId, "sk_3d_data_explainer");
  assert.equal(applied.request.cookbook?.id, "ck_3d_data_explainer");
  assert.equal(applied.request.constraints.maxMs, 60000, "the shorter of the person's cap and the cookbook's length");
  const script = applied.request.cookbook?.instructions.script ?? "";
  assert.ok(script.includes(`Direction (${DIRECTION_CODEX_VERSION})`), "every cookbook run carries the direction codex's script rules");
  assert.ok(script.includes("Format: Explainer with a visual metaphor."), "an explainer cookbook gets the matching format");
});

test("a draft run is offered the eligible cookbooks by label and version, read on the server from the session (K18c)", async () => {
  const id = await draftWithLength(60);
  const outcome = await proposalForRunFor(db.sql, { userId: ADMIN, sessionId: id });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  if (!outcome.ok) return;
  assert.equal(outcome.value.status, "not_connected", "the selector's port is not connected in this build, so the answer is the picker");
  if (outcome.value.status !== "not_connected") return;
  const explainer = outcome.value.eligible.find((ref) => ref.cookbookId === "ck_3d_data_explainer");
  assert.ok(explainer, "the free 3D explainer is eligible for a run with no paid inputs");
  assert.equal(explainer.version, 2);
  assert.equal(explainer.label, "3D data explainer");
});

test("a started run has no cookbook left to propose", async () => {
  const id = await draftWithLength(60);
  await db.sql`insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state) values ('req_proposal_started', ${ORG}, ${BRAND}, 'ref_proposal', 'normal', 'running', '{}')`;
  await db.sql`update content_factory_sessions set status = 'started', engine_request_id = 'req_proposal_started', started_at = now() where id = ${id}`;
  const outcome = await proposalForRunFor(db.sql, { userId: ADMIN, sessionId: id });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /already started/);
});

test("without a length there is no proposal: the reason is said in words", async () => {
  const id = await draftWithLength(null);
  const outcome = await proposalForRunFor(db.sql, { userId: ADMIN, sessionId: id });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "Set the length before choosing a cookbook.");
});

test("the live summary gives a cookbook's badge and estimate at the values on screen, for a draft run (K17)", async () => {
  const id = await draftWithLength(60);
  const { liveSummaryFor } = await import("./cookbook-choice.ts");
  const outcome = await liveSummaryFor(db.sql, { userId: ADMIN, sessionId: id, cookbookId: "ck_3d_data_explainer", version: 2, values: { pace: 1.2 } });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  if (!outcome.ok) return;
  assert.equal(outcome.value.cookbookId, "ck_3d_data_explainer");
  assert.ok(outcome.value.badge.length > 0);
  const refused = await liveSummaryFor(db.sql, { userId: ADMIN, sessionId: id, cookbookId: "ck_3d_data_explainer", version: 2, values: { pace: 999 } });
  assert.equal(refused.ok, false, "a value outside its control is refused, and nothing is shown for it");
});

test("the live summary needs a length, and a run that has started keeps its cookbook fixed (K17)", async () => {
  const noLength = await draftWithLength(null);
  const { liveSummaryFor } = await import("./cookbook-choice.ts");
  const outcome = await liveSummaryFor(db.sql, { userId: ADMIN, sessionId: noLength, cookbookId: "ck_3d_data_explainer", version: 2, values: {} });
  assert.equal(outcome.ok, false);
});
