// Video variations on PGlite with every migration. Creating variations writes drafts and one batch and nothing else: no engine request, no
// provider transport. A refusal writes nothing. The source draft is never changed and never joins the batch.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { createBatch } from "./batch-service.ts";
import { createVariations } from "./variation-service.ts";

const WS = "org_variations";
const OTHER_WS = "org_variations_other";
const BRAND = "brand_variations";
const ADMIN = "user_var_admin";
const MEMBER = "user_var_member";
const OUTSIDER = "user_var_outsider";

let db: TestDatabase;

async function counts() {
  const [row] = await db.sql<{ sessions: string; batches: string; items: string; messages: string; attachments: string; requests: string; audits: string }>`
    select
      (select count(*) from content_factory_sessions)::text as sessions,
      (select count(*) from content_factory_batches)::text as batches,
      (select count(*) from content_factory_batch_items)::text as items,
      (select count(*) from content_factory_messages)::text as messages,
      (select count(*) from content_factory_attachments)::text as attachments,
      (select count(*) from engine_requests)::text as requests,
      (select count(*) from audit_log where action like 'content_factory.variation%')::text as audits
  `;
  return row ?? { sessions: "-", batches: "-", items: "-", messages: "-", attachments: "-", requests: "-", audits: "-" };
}

type SourceOptions = { id: string; status?: string; reference?: boolean; market?: boolean; instruction?: string | null; script?: boolean; brand?: string | null };

/** A source draft: one instruction (carrying the Market record), one reference file message, and optionally a script line. */
async function source(options: SourceOptions): Promise<string> {
  const { id } = options;
  const status = options.status ?? "draft";
  const brand = options.brand === undefined ? BRAND : options.brand;
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, max_seconds, language, priority, engine_request_id)
    values (${id}, ${WS}, ${brand}, ${ADMIN}, ${`Source ${id}`}, ${status}, 30, 'en', 'normal', ${null})
  `;
  if (options.instruction !== null) {
    await db.sql`insert into content_factory_messages (id, organization_id, session_id, author_id, text, beat_role) values (${`${id}_m1`}, ${WS}, ${id}, ${ADMIN}, ${options.instruction ?? "Make a calm product demo in the brand voice."}, ${null})`;
  }
  await db.sql`insert into content_factory_messages (id, organization_id, session_id, author_id, text, beat_role) values (${`${id}_m2`}, ${WS}, ${id}, ${ADMIN}, ${""}, ${null})`;
  if (options.script) {
    await db.sql`insert into content_factory_messages (id, organization_id, session_id, author_id, text, beat_role) values (${`${id}_m3`}, ${WS}, ${id}, ${ADMIN}, ${"Hello, this exact line."}, ${"hook"})`;
  }
  if (options.reference !== false) {
    await db.sql`
      insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, purpose, file_name, storage_key, media_type, byte_size, sha256)
      values (${`${id}_ref`}, ${WS}, ${id}, ${`${id}_m2`}, 'file', 'reference_video', 'reference.mp4', ${`fixtures/${id}/reference.mp4`}, 'video/mp4', 1024, ${"a".repeat(64)})
    `;
  }
  if (options.market !== false) {
    await db.sql`
      insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, source_page, source_brand_id, source_record_id, snapshot)
      values (${`${id}_mkt`}, ${WS}, ${id}, ${`${id}_m2`}, 'source', 'market', ${BRAND}, ${`rec_${id}`}, ${"A competitor opens on the problem."})
    `;
  }
  return id;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await seedWorkspace(db.sql, OTHER_WS);
  for (const [id, org, role] of [[ADMIN, WS, "admin"], [MEMBER, WS, "member"], [OUTSIDER, OTHER_WS, "admin"]] as const) {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${id}`}, ${org}, ${id}, ${role})`;
  }
});

after(async () => {
  await db.close();
});

test("every refusal writes nothing: count, budget, role, workspace, and a source that is not ready", async () => {
  const ok = await source({ id: "s_ok" });
  const noRef = await source({ id: "s_noref", reference: false });
  const noMarket = await source({ id: "s_nomkt", market: false });
  const noInstruction = await source({ id: "s_noins", instruction: "short" });
  const scripted = await source({ id: "s_script", script: true });
  const noBrand = await source({ id: "s_nobrand", brand: null });
  const before = await counts();

  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: ok, count: 1, totalBudgetUsd: 10 }), /between 2 and 20/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: ok, count: 21, totalBudgetUsd: 100 }), /between 2 and 20/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: ok, count: 3, totalBudgetUsd: 0.5 }), /cannot cover 3 videos/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: ok, count: 3, totalBudgetUsd: Number.NaN }), /positive amount/);
  await assert.rejects(createVariations(db.sql, MEMBER, { sourceSessionId: ok, count: 3, totalBudgetUsd: 10 }));
  await assert.rejects(createVariations(db.sql, OUTSIDER, { sourceSessionId: ok, count: 3, totalBudgetUsd: 10 }), /not available to you/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: "nope", count: 3, totalBudgetUsd: 10 }), /not available to you/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: noRef, count: 3, totalBudgetUsd: 10 }), /uploaded reference video/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: noMarket, count: 3, totalBudgetUsd: 10 }), /Market research/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: noInstruction, count: 3, totalBudgetUsd: 10 }), /plain-language instruction/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: scripted, count: 3, totalBudgetUsd: 10 }), /script lines/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: noBrand, count: 3, totalBudgetUsd: 10 }), /no brand/);

  assert.deepEqual(await counts(), before, "no session, message, attachment, batch, item, audit or engine request was written");
});

test("a started source is refused", async () => {
  await db.sql`insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state, current_stage) values ('req_var_src', ${WS}, ${BRAND}, 'fmt', 'normal', 'running', '{}', 'intake')`;
  await db.sql`insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id, started_at) values ('s_started_real', ${WS}, ${BRAND}, ${ADMIN}, 'Started', 'started', 'req_var_src', now())`;
  const before = await counts();
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: "s_started_real", count: 3, totalBudgetUsd: 10 }), /Only a draft/);
  assert.deepEqual(await counts(), before);
});

test("three variations are drafts with lineage, copied instructions and attachments, exact budgets and one batch, and the source is untouched", async () => {
  const id = await source({ id: "s_main" });
  const before = await counts();
  const [sourceBefore] = await db.sql<{ title: string; status: string; budget_usd: unknown; updated_at: unknown }>`select title, status, budget_usd, updated_at from content_factory_sessions where id = ${id}`;

  const batch = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 10 });
  assert.equal(batch.items.length, 3);
  assert.deepEqual(batch.items.map((item) => item.state), ["ready", "ready", "ready"], "nothing is started");
  assert.ok(batch.items.every((item) => item.draft));
  assert.equal(batch.budgetUsd, 10);
  assert.deepEqual(batch.items.map((item) => item.budgetUsd), [3.34, 3.33, 3.33]);
  assert.equal(batch.committedUsd, 0);
  assert.ok(!batch.items.some((item) => item.sessionId === id), "the source is not in the batch");

  const after = await counts();
  assert.equal(Number(after.sessions) - Number(before.sessions), 3);
  assert.equal(Number(after.batches) - Number(before.batches), 1);
  assert.equal(Number(after.items) - Number(before.items), 3);
  assert.equal(after.requests, before.requests, "no engine request was made");
  assert.equal(Number(after.audits) - Number(before.audits), 4, "one audit per video and one for the batch");

  const rows = await db.sql<{ id: string; source_session_id: string; variation_angle: string; max_seconds: number; language: string }>`
    select id, source_session_id, variation_angle, max_seconds, language from content_factory_sessions where source_session_id = ${id} order by variation_angle
  `;
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.variation_angle)).size, 3, "each video has its own angle");
  assert.deepEqual(rows.map((row) => row.variation_angle).sort(), ["myth_bust", "problem_first", "result_first"]);
  assert.ok(rows.every((row) => row.max_seconds === 30 && row.language === "en"), "the source's settings are copied");

  for (const row of rows) {
    const messages = await db.sql<{ text: string; beat_role: string | null }>`select text, beat_role from content_factory_messages where session_id = ${row.id} order by created_at, id`;
    assert.ok(messages.every((message) => message.beat_role === null), "no script line");
    assert.ok(messages.some((message) => message.text === "Make a calm product demo in the brand voice."), "the plain instruction is copied");
    assert.ok(messages.some((message) => /^Variation angle: /.test(message.text) && /Never copy its footage, words, voice or music/.test(message.text)));
    const files = await db.sql<{ purpose: string; storage_key: string; sha256: string; message_id: string }>`select purpose, storage_key, sha256, message_id from content_factory_attachments where session_id = ${row.id} and kind = 'file'`;
    assert.equal(files.length, 1);
    assert.equal(files[0]?.purpose, "reference_video");
    assert.equal(files[0]?.storage_key, `fixtures/${id}/reference.mp4`, "the reference is shared by its storage record, not re-uploaded");
    const sources = await db.sql<{ source_record_id: string; snapshot: string }>`select source_record_id, snapshot from content_factory_attachments where session_id = ${row.id} and kind = 'source'`;
    assert.deepEqual(sources.map((item) => item.source_record_id), [`rec_${id}`]);
    const own = await db.sql<{ n: string }>`select count(*)::text as n from content_factory_messages where id = ${files[0]?.message_id ?? ""} and session_id = ${row.id}`;
    assert.equal(own[0]?.n, "1", "each attachment sits on a message of its own copy");
  }

  const [sourceAfter] = await db.sql<{ title: string; status: string; budget_usd: unknown; updated_at: unknown }>`select title, status, budget_usd, updated_at from content_factory_sessions where id = ${id}`;
  assert.deepEqual(sourceAfter, sourceBefore, "the source draft is unchanged");
  const [sourceMessages] = await db.sql<{ n: string }>`select count(*)::text as n from content_factory_messages where session_id = ${id}`;
  assert.equal(sourceMessages?.n, "2");
  const [sourceAttachments] = await db.sql<{ n: string }>`select count(*)::text as n from content_factory_attachments where session_id = ${id}`;
  assert.equal(sourceAttachments?.n, "2");

  await assert.rejects(createBatch(db.sql, ADMIN, { brandId: BRAND, title: "Template", budgetUsd: 10, sessionIds: [id] }), /template other videos were made from/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: rows[0]?.id ?? "", count: 2, totalBudgetUsd: 5 }), /original reusable draft/);
  const second = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 5 });
  assert.equal(second.items.length, 2, "the template can be used again");
  assert.notEqual(second.id, batch.id);
});

test("twenty variations split a budget exactly in cents, and the batch holds only the new videos", async () => {
  const id = await source({ id: "s_twenty" });
  const batch = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 20, totalBudgetUsd: 12.34 });
  assert.equal(batch.items.length, 20);
  const cents = batch.items.map((item) => Math.round((item.budgetUsd ?? 0) * 100));
  assert.equal(cents.reduce((sum, value) => sum + value, 0), 1234);
  assert.ok(Math.max(...cents) - Math.min(...cents) <= 1);
  assert.ok(Math.min(...cents) >= 52);
  const [stored] = await db.sql<{ budget_usd: string }>`select budget_usd from content_factory_batches where id = ${batch.id}`;
  assert.equal(Number(stored?.budget_usd), 12.34);
});

test("a source with a record from another brand is refused and writes nothing", async () => {
  await db.sql`insert into brands (id, organization_id, name, created_by) values ('brand_var_other', ${WS}, 'Other brand', 'test') on conflict (id) do nothing`;
  const foreign = await source({ id: "s_foreign", market: false });
  await db.sql`
    insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, source_page, source_brand_id, source_record_id, snapshot)
    values ('s_foreign_mkt', ${WS}, ${foreign}, 's_foreign_m2', 'source', 'market', 'brand_var_other', 'rec_foreign', 'Another brand record.')
  `;
  const before = await counts();
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: foreign, count: 3, totalBudgetUsd: 10 }), /must belong to this brand/);
  assert.deepEqual(await counts(), before);
});
