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

type SourceOptions = { id: string; status?: string; reference?: boolean; referenceMediaType?: string; referenceKey?: string; market?: boolean; marketSnapshot?: string; instruction?: string | null; script?: boolean; brand?: string | null; page?: boolean };

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
      values (${`${id}_ref`}, ${WS}, ${id}, ${`${id}_m2`}, 'file', 'reference_video', 'reference.mp4', ${options.referenceKey ?? `fixtures/${id}/reference.mp4`}, ${options.referenceMediaType ?? 'video/mp4'}, 1024, ${"a".repeat(64)})
    `;
  }
  if (options.market !== false) {
    await db.sql`
      insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, source_page, source_brand_id, source_record_id, snapshot)
      values (${`${id}_mkt`}, ${WS}, ${id}, ${`${id}_m2`}, 'source', 'market', ${BRAND}, ${`rec_${id}`}, ${options.marketSnapshot ?? "A competitor opens on the problem."})
    `;
  }
  if (options.page !== false) {
    await db.sql`
      insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, source_page, source_brand_id, source_record_id, snapshot)
      values (${`${id}_page`}, ${WS}, ${id}, ${`${id}_m2`}, 'source', 'page', ${BRAND}, 'page_var_1', ${"Kitchen hacks theme page."})
    `;
  }
  return id;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await seedWorkspace(db.sql, OTHER_WS);
  await db.sql`
    insert into theme_pages (id, organization_id, brand_id, name, niche, platform, style_kit_id, voice_kit_id)
    values ('page_var_1', ${WS}, ${BRAND}, 'Kitchen hacks', 'kitchen', 'instagram', 'style_var_1', 'voice_var_1')
  `;
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
  const wrongMimeReference = await source({ id: "s_ref_wrong_mime", referenceMediaType: "application/pdf" });
  const missingKeyReference = await source({ id: "s_ref_no_key", referenceKey: "" });
  const noMarket = await source({ id: "s_nomkt", market: false });
  const emptyMarket = await source({ id: "s_market_empty", marketSnapshot: "   " });
  const noInstruction = await source({ id: "s_noins", instruction: "short" });
  const scripted = await source({ id: "s_script", script: true });
  const noBrand = await source({ id: "s_nobrand", brand: null });
  const noPage = await source({ id: "s_nopage", page: false });
  const before = await counts();

  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: ok, count: 1, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /between 2 and 20/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: ok, count: 21, totalBudgetUsd: 100, approvedSample: true, stylePreset: "explainer" }), /between 2 and 20/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: ok, count: 3, totalBudgetUsd: 0.5, approvedSample: true, stylePreset: "explainer" }), /cannot cover 3 videos/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: ok, count: 3, totalBudgetUsd: Number.NaN, approvedSample: true, stylePreset: "explainer" }), /positive amount/);
  await assert.rejects(createVariations(db.sql, MEMBER, { sourceSessionId: ok, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }));
  await assert.rejects(createVariations(db.sql, OUTSIDER, { sourceSessionId: ok, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /not available to you/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: "nope", count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /not available to you/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: noRef, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /uploaded reference video/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: wrongMimeReference, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /uploaded reference video/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: missingKeyReference, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /uploaded reference video/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: noMarket, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /Market research/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: emptyMarket, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /Market research/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: noInstruction, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /plain-language instruction/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: scripted, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /script lines/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: noPage, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /theme page/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: noBrand, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /no brand/);

  assert.deepEqual(await counts(), before, "no session, message, attachment, batch, item, audit or engine request was written");
});

test("a started source is refused", async () => {
  await db.sql`insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state, current_stage) values ('req_var_src', ${WS}, ${BRAND}, 'fmt', 'normal', 'running', '{}', 'intake')`;
  await db.sql`insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id, started_at) values ('s_started_real', ${WS}, ${BRAND}, ${ADMIN}, 'Started', 'started', 'req_var_src', now())`;
  const before = await counts();
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: "s_started_real", count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /Only a draft/);
  assert.deepEqual(await counts(), before);
});

test("three variations are drafts with lineage, copied instructions and attachments, exact budgets and one batch, and the source is untouched", async () => {
  const id = await source({ id: "s_main" });
  const before = await counts();
  const [sourceBefore] = await db.sql<{ title: string; status: string; budget_usd: unknown; updated_at: unknown }>`select title, status, budget_usd, updated_at from content_factory_sessions where id = ${id}`;

  const batch = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" });
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
    const sources = await db.sql<{ source_record_id: string; snapshot: string }>`select source_record_id, snapshot from content_factory_attachments where session_id = ${row.id} and kind = 'source' order by source_record_id`;
    assert.deepEqual(sources.map((item) => item.source_record_id), ["page_var_1", `rec_${id}`], "the theme page and the Market record are both copied");
    const own = await db.sql<{ n: string }>`select count(*)::text as n from content_factory_messages where id = ${files[0]?.message_id ?? ""} and session_id = ${row.id}`;
    assert.equal(own[0]?.n, "1", "each attachment sits on a message of its own copy");
  }

  const [sourceAfter] = await db.sql<{ title: string; status: string; budget_usd: unknown; updated_at: unknown }>`select title, status, budget_usd, updated_at from content_factory_sessions where id = ${id}`;
  assert.deepEqual(sourceAfter, sourceBefore, "the source draft is unchanged");
  const [sourceMessages] = await db.sql<{ n: string }>`select count(*)::text as n from content_factory_messages where session_id = ${id}`;
  assert.equal(sourceMessages?.n, "2");
  const [sourceAttachments] = await db.sql<{ n: string }>`select count(*)::text as n from content_factory_attachments where session_id = ${id}`;
  assert.equal(sourceAttachments?.n, "3");

  await assert.rejects(createBatch(db.sql, ADMIN, { brandId: BRAND, title: "Template", budgetUsd: 10, sessionIds: [id] }), /template other videos were made from/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: rows[0]?.id ?? "", count: 2, totalBudgetUsd: 5, approvedSample: true, stylePreset: "explainer" }), /original reusable draft/);
  const second = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 5, approvedSample: true, stylePreset: "explainer" });
  assert.equal(second.items.length, 2, "the template can be used again");
  assert.notEqual(second.id, batch.id);
});

test("twenty variations split a budget exactly in cents, and the batch holds only the new videos", async () => {
  const id = await source({ id: "s_twenty" });
  const batch = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 20, totalBudgetUsd: 12.34, approvedSample: true, stylePreset: "explainer" });
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
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: foreign, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" }), /must belong to this brand/);
  assert.deepEqual(await counts(), before);
});

test("an identical repeated request returns the same batch, and a changed or later request makes a new one", async () => {
  const id = await source({ id: "s_replay" });
  const first = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" });
  const before = await counts();
  const again = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" });
  assert.equal(again.id, first.id, "a double click or a replay returns the batch already made");
  assert.deepEqual(await counts(), before, "and writes nothing");

  const changed = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 11, approvedSample: true, stylePreset: "explainer" });
  assert.notEqual(changed.id, first.id, "a different total is a different request");
  await db.sql`update content_factory_batches set created_at = now() - interval '1 hour' where id = ${first.id}`;
  await db.sql`update content_factory_batches set created_at = now() - interval '1 hour' where id = ${changed.id}`;
  const later = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" });
  assert.notEqual(later.id, first.id, "the same request an hour later is a new batch");
});

test("a brand's session list is scoped to the brand and is not cut at the workspace-wide 100", async () => {
  const { listSessions, BRAND_SESSION_LIST_LIMIT } = await import("./service.ts");
  for (let i = 0; i < 130; i += 1) {
    await db.sql`insert into content_factory_sessions (id, organization_id, brand_id, title) values (${`s_many_${i}`}, ${WS}, ${BRAND}, ${`Many ${i}`})`;
  }
  const workspaceWide = await listSessions(db.sql, ADMIN, { organizationId: WS });
  assert.equal(workspaceWide.length, 100, "the workspace-wide list keeps its limit");
  const brandWide = await listSessions(db.sql, ADMIN, { organizationId: WS, brandId: BRAND });
  assert.ok(brandWide.length > 130 && brandWide.length <= BRAND_SESSION_LIST_LIMIT);
  assert.ok(brandWide.every((item) => item.brandId === BRAND));
  const none = await listSessions(db.sql, ADMIN, { organizationId: WS, brandId: "brand_nope" });
  assert.deepEqual(none, []);
});

async function seedPatterns(brand: string, rows: Array<[string, string, number]>, corpus = 9): Promise<void> {
  for (const [dimension, value, samples] of rows) {
    await db.sql`
      insert into research_patterns (id, organization_id, brand_id, scope, dimension, value, state, sample_count, corpus_size, prevalence, confidence, summary)
      values (${`pat_${brand}_${dimension}_${value}`}, ${WS}, ${brand}, 'brand', ${dimension}, ${value}, 'INFERRED', ${samples}, ${corpus}, ${samples / corpus}, 0.8, 'Model-labelled.')
    `;
  }
}

test("research-based variations use the brand's own patterns first, fixed angles for the rest, and refuse when there is no format", async () => {
  const { researchFormatOf } = await import("./variation-service.ts");
  const id = await source({ id: "s_research" });
  const before = await counts();
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 10, useResearchFormat: true, approvedSample: true, stylePreset: "explainer" }), /Pattern-finding needs at least 3/);
  assert.deepEqual(await counts(), before, "a refusal writes nothing and does not fall back to the fixed angles");
  const empty = await researchFormatOf(db.sql, ADMIN, { brandId: BRAND });
  assert.equal(empty.ok, false);
  await assert.rejects(researchFormatOf(db.sql, MEMBER, { brandId: BRAND }));

  await seedPatterns(BRAND, [["structure", "problem_solution", 4], ["structure", "listicle", 2], ["openingMove", "question", 3], ["cta", "learn_more", 3]]);
  const found = await researchFormatOf(db.sql, ADMIN, { brandId: BRAND });
  assert.ok(found.ok);

  const batch = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 4, totalBudgetUsd: 10, useResearchFormat: true, approvedSample: true, stylePreset: "explainer" });
  assert.equal(batch.items.length, 4);
  const angles = batch.items.map((item) => item.angle ?? "");
  assert.equal(angles.filter((angle) => angle.startsWith("res_")).length, 2, "two structures with one opening each");
  assert.deepEqual(angles.slice(2), ["problem_first", "result_first"], "the fixed angles fill the rest, in order");
  assert.match(batch.items[0]?.title ?? "", /Problem solution, question opening/);
  const [message] = await db.sql<{ text: string }>`
    select m.text from content_factory_messages m join content_factory_sessions s on s.id = m.session_id
    where s.id = ${batch.items[0]?.sessionId ?? ""} and m.text like 'Variation angle:%'
  `;
  assert.match(message?.text ?? "", /4 of 9 analyzed ads/);
  assert.match(message?.text ?? "", /Never copy its footage, words, voice or music/);
  const [audit] = await db.sql<{ metadata: string }>`select metadata from audit_log where object_id = ${batch.id} and action = 'content_factory.variations_batch_created'`;
  assert.match(String(audit?.metadata ?? ""), /"researchAngles":"2"/);

  // The same count and total without the research format is a different request, not a replay of this one.
  const plain = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 4, totalBudgetUsd: 10, approvedSample: true, stylePreset: "explainer" });
  assert.notEqual(plain.id, batch.id);
  assert.ok(plain.items.every((item) => !(item.angle ?? "").startsWith("res_")));
});

test("another brand's research patterns are never used", async () => {
  await db.sql`insert into brands (id, organization_id, name, created_by) values ('brand_var_pat_other', ${WS}, 'Pattern other', 'test') on conflict (id) do nothing`;
  await seedPatterns("brand_var_pat_other", [["structure", "testimonial", 5]]);
  const { researchFormatOf } = await import("./variation-service.ts");
  const own = await researchFormatOf(db.sql, ADMIN, { brandId: BRAND });
  assert.ok(own.ok && !own.format.structures.some((item) => item.value === "testimonial"));
});

test("the source list says which drafts are ready and why each other one is not, and leaves derived variations out", async () => {
  const { variationSourcesOf } = await import("./variation-service.ts");
  await source({ id: "s_list_ok" });
  await source({ id: "s_list_noref", reference: false });
  await source({ id: "s_list_script", script: true });
  const list = await variationSourcesOf(db.sql, ADMIN, { brandId: BRAND });
  const byId = new Map(list.map((item) => [item.id, item.problem]));
  assert.equal(byId.get("s_list_ok"), null);
  assert.match(byId.get("s_list_noref") ?? "", /uploaded reference video/);
  assert.match(byId.get("s_list_script") ?? "", /script lines/);
  assert.ok(list.every((item) => !item.title.includes(": Problem first") && !item.title.includes(": Result first")));
  await assert.rejects(variationSourcesOf(db.sql, MEMBER, { brandId: BRAND }));
  assert.deepEqual(await variationSourcesOf(db.sql, ADMIN, { brandId: "brand_nope" }).catch(() => "refused"), "refused");
});

test("without the person's approval of the sample, nothing is created", async () => {
  const id = await source({ id: "s_unapproved" });
  const before = await counts();
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 10 }), /approve the format first/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 10, approvedSample: false }), /approve the format first/);
  assert.deepEqual(await counts(), before);
});

test("a style preset adds a style instruction to each draft and is recorded; Auto follows the research and Super mixes; an unknown style is refused", async () => {
  const { STYLE_PRESETS } = await import("./style-presets.ts");
  const id = await source({ id: "s_style" });
  const before = await counts();
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "cinematic" }), /Choose a style/);
  assert.deepEqual(await counts(), before, "an unknown style writes nothing");

  const one = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 4, approvedSample: true, stylePreset: "explainer" });
  assert.deepEqual(one.items.map((item) => item.style), ["explainer", "explainer"]);
  const [text] = await db.sql<{ text: string }>`select text from content_factory_messages where session_id = ${one.items[0]?.sessionId ?? ""} and text like 'Style preset:%'`;
  assert.match(text?.text ?? "", /^Style preset: Explainer\./);
  assert.match(text?.text ?? "", /no real person's likeness/);

  // Decision 5: a batch takes a cookbook's style, so a batch with no style and no cookbook is refused, and writes nothing.
  const beforeNone = await counts();
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 5, approvedSample: true, stylePreset: "none" }), /Choose a cookbook for the batch/);
  assert.deepEqual(await counts(), beforeNone, "the refused batch writes nothing");

  const mix = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 9, approvedSample: true, stylePreset: "super" });
  assert.deepEqual(mix.items.map((item) => item.style), ["product_promo", "explainer", "talking_head"], "Super walks the styles some cookbook carries, in library order");
  assert.ok(STYLE_PRESETS.length >= 8);

  // Auto with research: the most common structure maps to a fixed preset. No research format leaves it a mix.
  const autoNoResearch = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 6, approvedSample: true, stylePreset: "auto" });
  assert.notEqual(new Set(autoNoResearch.items.map((item) => item.style)).size, 0);
});

test("the style and the angle reach the engine: a variation started through the real start path stores a brief that contains both", async () => {
  const { startRun } = await import("./service.ts");
  const { stagesNeeded } = await import("../../../engine/api/index.ts");
  const ports = {
    monthBudget: { monthBudget: async () => ({ status: "known" as const, usd: 100 }) },
    credentials: { get: async () => ({ status: "ready" as const, credential: { kind: "api_key" as const, secret: "fixture-not-a-key" } }) },
    runtime: { handlers: Object.fromEntries(stagesNeeded(0).map((stage) => [stage, { async run() { throw new Error("not run by this test"); } }])) },
  } as never;
  const id = await source({ id: "s_reach" });
  const batch = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 4, approvedSample: true, stylePreset: "tips_list" });
  const first = batch.items[0];
  assert.ok(first);
  const outcome = await startRun(db.sql, ADMIN, { sessionId: first.sessionId }, { readiness: ports });
  assert.equal(outcome.status, "started", outcome.status === "refused" ? [...outcome.problems, ...outcome.notConnected].join(" | ") : "");
  const [row] = await db.sql<{ engine_request_id: string }>`select engine_request_id from content_factory_sessions where id = ${first.sessionId}`;
  const [artifact] = await db.sql<{ body: string }>`
    select body from engine_artifacts where request_id = ${row?.engine_request_id ?? ""} and type = 'production_request' order by created_at desc limit 1
  `;
  const request = JSON.parse(String(artifact?.body ?? "{}")) as { brief?: { text?: string } };
  const brief = request.brief?.text ?? "";
  assert.match(brief, /Make a calm product demo in the brand voice\./, "the source's own instruction is in the brief");
  assert.match(brief, /Variation angle: Problem first\./, "the angle is in the brief");
  assert.match(brief, /Style preset: Tips list\. Make a numbered tips video/, "the style is in the brief");
  assert.match(brief, /no real person's likeness/, "and so is the safety line");
});

test("the orchestrator chooses the styles: one call, ranked, recorded; and a source that would be refused never reaches the engine", async () => {
  const calls: Array<{ brandName: string; instruction: string }> = [];
  const good = async ({ facts }: { facts: { brandName: string; instruction: string } }) => {
    calls.push({ brandName: facts.brandName, instruction: facts.instruction });
    return { ok: true as const, ranked: ["tips_list", "explainer", "product_promo"], chosen: "tips_list", confidence: 0.64, engine: "jev", model: "recorded-model" };
  };
  const id = await source({ id: "s_orch" });
  const batch = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 4, totalBudgetUsd: 8, approvedSample: true, stylePreset: "orchestrator", chooseStyle: good as never });
  assert.equal(calls.length, 1, "one engine call for the whole batch");
  assert.match(calls[0]?.instruction ?? "", /calm product demo/, "the engine is given the source's goal");
  assert.deepEqual(batch.items.map((item) => item.style), ["tips_list", "explainer", "product_promo", "tips_list"]);
  const [text] = await db.sql<{ text: string }>`select text from content_factory_messages where session_id = ${batch.items[1]?.sessionId ?? ""} and text like 'Style preset:%'`;
  assert.match(text?.text ?? "", /^Style preset: Explainer\./);
  const [audit] = await db.sql<{ metadata: string }>`select metadata from audit_log where object_id = ${batch.id} and action = 'content_factory.variations_batch_created'`;
  assert.match(String(audit?.metadata), /"style":"orchestrator"/);
  assert.match(String(audit?.metadata), /"styleEngine":"jev"/);
  assert.match(String(audit?.metadata), /"styleModel":"recorded-model"/);

  // A source that is not ready is refused before the engine is asked, so no model call is spent on it.
  const notReady = await source({ id: "s_orch_noref", reference: false });
  const callsBefore = calls.length;
  const before = await counts();
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: notReady, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "orchestrator", chooseStyle: good as never }), /uploaded reference video/);
  assert.equal(calls.length, callsBefore, "the engine was not called");
  assert.deepEqual(await counts(), before);
});

test("when the decision engine will not choose, nothing is created and there is no silent fallback to a rule", async () => {
  const id = await source({ id: "s_orch_refused" });
  const before = await counts();
  const refusing = async () => ({ ok: false as const, reason: "The decision engine could not answer: No TypeSafe key is saved." });
  await assert.rejects(
    createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 10, approvedSample: true, stylePreset: "orchestrator", chooseStyle: refusing }),
    /No TypeSafe key is saved\. No style was chosen, so nothing was created\./,
  );
  assert.deepEqual(await counts(), before, "no session, message, batch or audit was written");
});

test("through the real dispatcher, an engine that is not connected refuses, and a recorded answer from a registered engine is used", async () => {
  const { chooseStyleWithEngine, STYLE_QUESTION_ID } = await import("./style-chooser.ts");
  const id = await source({ id: "s_orch_real" });
  // With no key in this test environment, the default engine is not connected: the real chooser reports it and creates nothing.
  const before = await counts();
  await assert.rejects(
    createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 4, approvedSample: true, stylePreset: "orchestrator", chooseStyle: chooseStyleWithEngine }),
    /No style was chosen, so nothing was created\./,
  );
  assert.deepEqual(await counts(), before);
  assert.equal(STYLE_QUESTION_ID, "content.video_style.v1");

  // A recorded answer from a registered engine, through the real dispatcher: the engine receives the style question under its own name, and
  // its answer is read back from that name into a ranking the videos take in order.
  const { chooserFor, STYLE_QUESTION_KEY } = await import("./style-chooser.ts");
  const seen: Array<{ keys: string[]; options: string[]; state: string }> = [];
  const fake = {
    id: "jev",
    adapterVersion: "recorded",
    capabilities: () => ({}),
    health: async () => ({ status: "READY" }),
    async decide(request: { questions: Record<string, { id: string; version: string; criteria: Record<string, string> }>; state: { description: string } }) {
      const question = request.questions[STYLE_QUESTION_KEY];
      seen.push({ keys: Object.keys(request.questions), options: Object.keys(question?.criteria ?? {}), state: request.state.description });
      return {
        runId: "run_recorded", model: "recorded-model", provider: "recorded", inputHash: "h", cached: false, latencyMs: 1, engineId: "jev", adapterVersion: "recorded", requestedModel: "recorded-model",
        returnedModel: "recorded-model", inputModality: "text", imageCount: 0, imagesOmitted: 0,
        answers: { [STYLE_QUESTION_KEY]: { questionId: question?.id ?? "", questionVersion: question?.version ?? "", type: "choice", model: "recorded-model", provider: "recorded", status: "answered", answer: "explainer", choice: "explainer", probabilities: { explainer: 0.6, tips_list: 0.25, product_promo: 0.1, cinematic_story: 0.05 }, confidence: 0.6, evidenceRefs: [], evaluatedAt: "2026-11-01T00:00:00.000Z" } },
      };
    },
  };
  const registry = { jev: fake, "openai-decisions": fake, "openrouter-decisions": fake } as never;
  const real = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 3, totalBudgetUsd: 9, approvedSample: true, stylePreset: "orchestrator", chooseStyle: chooserFor(registry) });
  assert.deepEqual(real.items.map((item) => item.style), ["explainer", "tips_list", "product_promo"], "the recorded ranking is used in order, and a style no cookbook carries (cinematic story) is left out");
  assert.deepEqual(seen[0]?.keys, ["style"]);
  assert.equal(seen[0]?.options.length, 5, "every style a cookbook carries is an option; the three with no cookbook are not offered");
  assert.match(seen[0]?.state ?? "", /^Brand: .*Goal \(data\): .*calm product demo/);
});

test("decision 5: the cookbook a batch names decides every video's style; a blank cookbook has none; a style no cookbook carries is refused; an unknown cookbook is refused", async () => {
  const id = await source({ id: "s_cookbook_decides" });
  const before = await counts();
  const named = await createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 4, approvedSample: true, cookbookId: "ck_ugc_product" });
  assert.deepEqual(named.items.map((item) => item.style), ["ugc_style", "ugc_style"], "the cookbook's style is every video's style");
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 4, approvedSample: true, cookbookId: "ck_blank_brief" }), /has no style, so a batch cannot brief from it/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 4, approvedSample: true, stylePreset: "cinematic_story" }), /No cookbook carries the Cinematic story style/);
  await assert.rejects(createVariations(db.sql, ADMIN, { sourceSessionId: id, count: 2, totalBudgetUsd: 4, approvedSample: true, cookbookId: "ck_does_not_exist" }), /No such cookbook/);
  const after = await counts();
  assert.equal(after.batches, String(Number(before.batches) + 1), "only the accepted batch was written");
});
