// Content Factory on PGlite (or PostgreSQL with MERIDIAN_PG_TEST_URL): who may read and change a session, where files go, which sources
// can be attached, and the start of one run through the engine's API. Files go to an in-memory store and the engine's readiness ports are
// scripted, so nothing here reads a key or calls a provider.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { engineRequestStatus, stagesNeeded, type EngineReadinessPorts } from "../../../engine/api/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Sql } from "../learning/store.ts";
import type { ContentFactoryFileStore } from "./files.ts";
import { problemWords } from "./request.ts";
import {
  ADMIN_REFUSAL,
  attachSource,
  BRAND_REFUSAL,
  createSession,
  getSession,
  listSessions,
  MESSAGE_REFUSAL,
  postMessage,
  readRun,
  remakeShot,
  shotRemakeQuote,
  shotTakeOf,
  reviseSession,
  saveSettings,
  searchSources,
  SESSION_REFUSAL,
  startRun,
  STARTED_REFUSAL,
  uploadFile,
  WORKSPACE_REFUSAL,
} from "./service.ts";

const WS = "ws_cf_a";
const OTHER_WS = "ws_cf_b";
const BRAND = "brand_cf_a";
const OTHER_BRAND = "brand_cf_b";
const ADMIN = "user_cf_admin";
const OWNER = "user_cf_owner";
const MEMBER = "user_cf_member";
const VIEWER = "user_cf_viewer";
const OTHER_ADMIN = "user_cf_other_admin";
const STRANGER = "user_cf_stranger";

const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]).toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).toString("base64");
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]).toString("base64");

async function seedUser(sql: Sql, userId: string, organizationId: string | null, role: string | null): Promise<void> {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@fixture.example`}, true)`;
  if (organizationId !== null && role !== null) {
    await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${userId}`}, ${organizationId}, ${userId}, ${role})`;
  }
}

function memoryStore(ready = true): ContentFactoryFileStore & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    async ready() {
      return ready ? { status: "ready" } : { status: "not_connected", reason: "Google Drive is not connected for this workspace (fixture)." };
    },
    async put(input) {
      puts.push(`${input.organizationId}/${input.brandId}/${input.key}`);
      return { storageObjectId: null };
    },
  };
}

function readyPorts(): EngineReadinessPorts {
  const stub = { async run() { throw new Error("not run by this test"); } };
  return {
    monthBudget: { monthBudget: async () => ({ status: "known", usd: 100 }) },
    credentials: { get: async () => ({ status: "ready", credential: { kind: "api_key", secret: "fixture-not-a-key" } }) },
    runtime: { handlers: Object.fromEntries(stagesNeeded(0).map((stage) => [stage, stub])) as EngineReadinessPorts["runtime"]["handlers"] },
  } as EngineReadinessPorts;
}

function notConnectedPorts(): EngineReadinessPorts {
  return {
    ...readyPorts(),
    credentials: { get: async () => ({ status: "not_connected", reason: "no key is saved (fixture)" }) },
  } as EngineReadinessPorts;
}

describe("Content Factory sessions", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
    await seedWorkspace(db.sql, OTHER_WS, OTHER_BRAND);
    await seedUser(db.sql, ADMIN, WS, "admin");
    await seedUser(db.sql, OWNER, WS, "owner");
    await seedUser(db.sql, MEMBER, WS, "member");
    await seedUser(db.sql, VIEWER, WS, "viewer");
    await seedUser(db.sql, OTHER_ADMIN, OTHER_WS, "admin");
    await seedUser(db.sql, STRANGER, null, null);
    await db.sql`
      insert into products (id, brand_id, name, description, benefits, price, created_by)
      values ('prod_cf_1', ${BRAND}, 'Blender X', 'A quiet blender', 'quiet; fast', '$89', 'test'),
             ('prod_cf_other', ${OTHER_BRAND}, 'Other product', 'not ours', '', '', 'test')
    `;
    await db.sql`
      insert into theme_pages (id, organization_id, brand_id, name, niche, platform, style_kit_id, voice_kit_id)
      values ('page_cf_1', ${WS}, ${BRAND}, 'Kitchen hacks', 'kitchen', 'instagram', 'style_cf_1', 'voice_cf_1')
    `;
  });

  after(async () => {
    await db.close();
  });

  test("only admins and owners of the workspace list and create sessions; members, viewers, strangers and other workspaces are refused", async () => {
    const created = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: null, title: "Idea one" });
    assert.equal(created.status, "draft");
    assert.equal(created.brandId, null, "a session may have no brand");
    assert.ok((await listSessions(db.sql, OWNER, { organizationId: WS })).some((item) => item.id === created.id));

    await assert.rejects(listSessions(db.sql, MEMBER, { organizationId: WS }), { message: ADMIN_REFUSAL });
    await assert.rejects(listSessions(db.sql, VIEWER, { organizationId: WS }), { message: ADMIN_REFUSAL });
    await assert.rejects(listSessions(db.sql, STRANGER, { organizationId: WS }), { message: WORKSPACE_REFUSAL });
    await assert.rejects(listSessions(db.sql, OTHER_ADMIN, { organizationId: WS }), { message: WORKSPACE_REFUSAL });
    await assert.rejects(createSession(db.sql, MEMBER, { organizationId: WS, brandId: null, title: "No" }), { message: ADMIN_REFUSAL });
    await assert.rejects(createSession(db.sql, ADMIN, { organizationId: WS, brandId: OTHER_BRAND, title: "Foreign brand" }), { message: BRAND_REFUSAL });

    const theirs = await listSessions(db.sql, OTHER_ADMIN, { organizationId: OTHER_WS });
    assert.equal(theirs.length, 0, "the other workspace sees none of this workspace's sessions");
  });

  test("a shot is remade only by an admin of the session's workspace, and only once the video exists; before that the refusal says so", async () => {
    const shot = "shot_01M4T7V8BR00000000000AFP71";
    const created = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Remake" });
    await assert.rejects(remakeShot(db.sql, MEMBER, { sessionId: created.id, shotId: shot, directive: null }), { message: ADMIN_REFUSAL });
    await assert.rejects(remakeShot(db.sql, OTHER_ADMIN, { sessionId: created.id, shotId: shot, directive: null }), { message: SESSION_REFUSAL });
    assert.deepEqual(await remakeShot(db.sql, ADMIN, { sessionId: created.id, shotId: shot, directive: "close up" }), {
      status: "refused",
      reasons: ["This session has no video yet. Make the video first."],
    });
  });

  test("a shot's take and its remake quote are read only by an admin of the session's workspace; with no video there is no take, nothing is signed and the quote is refused", async () => {
    const shot = "shot_01M4T7V8BR00000000000AFP71";
    const created = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Take" });
    await assert.rejects(shotTakeOf(db.sql, MEMBER, { sessionId: created.id, shotId: shot }), { message: ADMIN_REFUSAL });
    await assert.rejects(shotRemakeQuote(db.sql, OTHER_ADMIN, { sessionId: created.id, shotId: shot }), { message: SESSION_REFUSAL });
    const signed: string[] = [];
    const signer = {
      sign: async (_organizationId: string, key: string) => {
        signed.push(key);
        return { status: "ok" as const, url: "https://media.example.test/take.mp4" };
      },
    };
    assert.deepEqual(await shotTakeOf(db.sql, ADMIN, { sessionId: created.id, shotId: shot }, signer), {
      status: "not_ready",
      reason: "This session has no video yet.",
    });
    assert.deepEqual(signed, [], "nothing is signed for a session with no video");
    assert.deepEqual(await shotRemakeQuote(db.sql, ADMIN, { sessionId: created.id, shotId: shot }), {
      status: "refused",
      reasons: ["This session has no video yet. Make the video first."],
    });
  });

  test("a session is read and changed only in its own workspace, by its admins; an unknown id gets the same refusal", async () => {
    const created = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Tenancy" });
    await assert.rejects(getSession(db.sql, OTHER_ADMIN, { sessionId: created.id }), { message: SESSION_REFUSAL });
    await assert.rejects(getSession(db.sql, STRANGER, { sessionId: created.id }), { message: SESSION_REFUSAL });
    await assert.rejects(getSession(db.sql, ADMIN, { sessionId: "no-such-session" }), { message: SESSION_REFUSAL });
    await assert.rejects(getSession(db.sql, MEMBER, { sessionId: created.id }), { message: ADMIN_REFUSAL });
    await assert.rejects(postMessage(db.sql, OTHER_ADMIN, { sessionId: created.id, text: "hi", beatRole: null }), { message: SESSION_REFUSAL });
    await assert.rejects(readRun(db.sql, VIEWER, { sessionId: created.id }, { readiness: readyPorts(), files: memoryStore() }), { message: ADMIN_REFUSAL });
    await assert.rejects(startRun(db.sql, OTHER_ADMIN, { sessionId: created.id }, { readiness: readyPorts() }), { message: SESSION_REFUSAL });
    await assert.rejects(saveSettings(db.sql, ADMIN, { sessionId: created.id, brandId: OTHER_BRAND, budgetUsd: null, maxSeconds: null, language: null, priority: null, keepGenes: [] }), { message: BRAND_REFUSAL });
  });

  test("files are checked from their bytes, need a brand and a connected store, and are stored under the session", async () => {
    const noBrand = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: null, title: "No brand" });
    const first = await postMessage(db.sql, ADMIN, { sessionId: noBrand.id, text: "Here is the reel.", beatRole: null });
    const store = memoryStore();
    const unbranded = await uploadFile(db.sql, ADMIN, { sessionId: noBrand.id, messageId: first.messageId, fileName: "reel.mp4", purpose: "reference_video", base64: MP4 }, { files: store });
    assert.equal(unbranded.status, "not_connected");
    assert.equal(store.puts.length, 0);

    const session = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Files" });
    const message = await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Reference attached.", beatRole: null });

    const program = await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: message.messageId, fileName: "reel.mp4", purpose: "material", base64: EXE }, { files: store });
    assert.equal(program.status, "refused", "a program named .mp4 is still a program");
    const imageAsReference = await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: message.messageId, fileName: "a.png", purpose: "reference_video", base64: PNG }, { files: store });
    assert.equal(imageAsReference.status, "refused");
    const offline = await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: message.messageId, fileName: "reel.mp4", purpose: "reference_video", base64: MP4 }, { files: memoryStore(false) });
    assert.equal(offline.status, "not_connected");
    assert.match(offline.status === "not_connected" ? offline.reason : "", /Google Drive is not connected/);
    assert.equal(store.puts.length, 0, "nothing is sent for a refused or unconnected file");

    const stored = await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: message.messageId, fileName: "notes.png", purpose: "material", base64: PNG }, { files: store });
    assert.equal(stored.status, "stored");
    assert.equal(stored.status === "stored" ? stored.mediaType : "", "image/png");
    assert.equal(store.puts.length, 1);
  });

  test("a text file keeps its content for the brief, a PDF says its text is not read, and a long text file is refused", async () => {
    const session = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Text inputs" });
    const message = await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Use the angle in the note.", beatRole: null });
    const store = memoryStore();
    const note = "Lead with the quiet test, not the price.";
    const text = await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: message.messageId, fileName: "angle.txt", purpose: "material", base64: Buffer.from(note).toString("base64") }, { files: store });
    assert.equal(text.status, "stored");
    assert.equal(text.status === "stored" ? text.mediaType : "", "text/plain");
    const pdf = await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: message.messageId, fileName: "specs.pdf", purpose: "material", base64: Buffer.from("%PDF-1.7\n").toString("base64") }, { files: store });
    assert.equal(pdf.status, "stored");
    const long = await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: message.messageId, fileName: "long.txt", purpose: "material", base64: Buffer.from("a".repeat(4001)).toString("base64") }, { files: store });
    assert.equal(long.status, "refused");
    assert.equal(long.status === "refused" ? long.reason : "", "This file has 4001 characters; the limit for a text file is 4000. Shorten it or split it into two files.");
    assert.equal(store.puts.length, 2, "the text file and the PDF are stored; the refused file is not");

    const detail = await getSession(db.sql, ADMIN, { sessionId: session.id });
    const files = detail.messages.flatMap((item) => item.attachments).flatMap((item) => (item.kind === "file" ? [item] : []));
    assert.equal(files.find((item) => item.fileName === "angle.txt")?.content, note);
    assert.equal(files.find((item) => item.fileName === "specs.pdf")?.content, null);

    const view = await readRun(db.sql, ADMIN, { sessionId: session.id }, { readiness: readyPorts(), files: store });
    assert.equal(view.stage, "draft");
    assert.ok(view.stage === "draft" && view.inputs.includes(`angle.txt: read into the brief, ${note.length} characters.`));
    assert.ok(view.stage === "draft" && view.inputs.includes("specs.pdf: PDF text could not be read, so it is not in the brief. The file is kept with the session."));
  });

  test("a file cannot be attached to another session's message", async () => {
    const one = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "One" });
    const two = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Two" });
    const message = await postMessage(db.sql, ADMIN, { sessionId: one.id, text: "mine", beatRole: null });
    await assert.rejects(
      uploadFile(db.sql, ADMIN, { sessionId: two.id, messageId: message.messageId, fileName: "reel.mp4", purpose: "material", base64: MP4 }, { files: memoryStore() }),
      { message: MESSAGE_REFUSAL },
    );
  });

  test("sources are searched and attached from existing records of a brand in the workspace, read again on the server", async () => {
    const session = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: null, title: "Sources" });
    const message = await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Use our product.", beatRole: null });
    const products = await searchSources(db.sql, ADMIN, { sessionId: session.id, brandId: BRAND, page: "product", query: "blender" });
    assert.deepEqual(products.map((item) => item.recordId), ["prod_cf_1"]);
    assert.match(products[0]?.snapshot ?? "", /Benefits: quiet; fast/);
    await assert.rejects(searchSources(db.sql, ADMIN, { sessionId: session.id, brandId: OTHER_BRAND, page: "product", query: "" }), { message: BRAND_REFUSAL });
    await assert.rejects(searchSources(db.sql, OTHER_ADMIN, { sessionId: session.id, brandId: OTHER_BRAND, page: "product", query: "" }), { message: SESSION_REFUSAL });
    await assert.rejects(
      attachSource(db.sql, ADMIN, { sessionId: session.id, messageId: message.messageId, brandId: BRAND, page: "product", recordId: "prod_cf_other" }),
      /not on the page/,
      "a product of another workspace's brand is not found under this brand",
    );
    const attached = await attachSource(db.sql, ADMIN, { sessionId: session.id, messageId: message.messageId, brandId: BRAND, page: "product", recordId: "prod_cf_1" });
    assert.match(attached.snapshot, /Blender X/);
    const brain = await searchSources(db.sql, ADMIN, { sessionId: session.id, brandId: BRAND, page: "brain", query: "" });
    assert.equal(brain.length, 1);
    const detail = await getSession(db.sql, ADMIN, { sessionId: session.id });
    assert.equal(detail.messages[0]?.attachments[0]?.kind, "source");
  });

  test("a session started while a file is being checked takes no file: the draft check runs again under the session's lock", async () => {
    const session = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Start during upload" });
    const intro = await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Same pacing as this reel, for our blender.", beatRole: null });
    const store = memoryStore();
    await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: intro.messageId, fileName: "reel.mp4", purpose: "reference_video", base64: MP4 }, { files: store });
    await attachSource(db.sql, ADMIN, { sessionId: session.id, messageId: intro.messageId, brandId: BRAND, page: "page", recordId: "page_cf_1" });
    await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Your smoothie is lying to you.", beatRole: "hook" });
    await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Send BLEND for the link.", beatRole: "cta" });
    await saveSettings(db.sql, ADMIN, { sessionId: session.id, budgetUsd: 4, maxSeconds: 30, language: "en", priority: "normal", keepGenes: ["pacing"] });

    // The store is asked whether it is connected after the draft check and before the file is recorded. The run starts in that gap.
    const starting: ContentFactoryFileStore = {
      ready: async () => {
        const started = await startRun(db.sql, ADMIN, { sessionId: session.id }, { readiness: readyPorts() });
        assert.equal(started.status, "started");
        return { status: "ready" };
      },
      put: store.put,
    };
    await assert.rejects(
      uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: intro.messageId, fileName: "notes.png", purpose: "material", base64: PNG }, { files: starting }),
      { message: STARTED_REFUSAL },
    );
    const detail = await getSession(db.sql, ADMIN, { sessionId: session.id });
    assert.equal(detail.status, "started");
    const files = detail.messages.flatMap((item) => item.attachments).flatMap((item) => (item.kind === "file" ? [item.fileName] : []));
    assert.deepEqual(files, ["reel.mp4"], "the started session keeps the files it had before the start, and no more");
  });

  test("a session with no reference video is refused at the start with the schema's reason, and nothing is started", async () => {
    // Counted before and after: an earlier test in this workspace starts a request of its own.
    const countRequests = async () => (await db.sql<{ n: number }>`select count(*)::int as n from engine_requests where organization_id = ${WS}`)[0]?.n ?? 0;
    const requestsBefore = await countRequests();
    const session = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "No reference" });
    await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "A reel for our blender, with the pacing of a saved reel.", beatRole: null });
    const view = await readRun(db.sql, ADMIN, { sessionId: session.id }, { readiness: readyPorts(), files: memoryStore() });
    assert.equal(view.stage, "draft");
    assert.ok(view.stage === "draft" && view.problems.includes(problemWords("format.referenceVideo")));
    assert.ok(view.stage === "draft" && view.hasReference === false);
    assert.ok(view.stage === "draft" && !view.problems.includes(problemWords("brief.text")), "the instruction is the brief's text");
    assert.ok(view.stage === "draft" && !view.problems.includes(problemWords("script.language")), "a brief needs no language");

    const outcome = await startRun(db.sql, ADMIN, { sessionId: session.id }, { readiness: readyPorts() });
    assert.equal(outcome.status, "refused");
    assert.ok(outcome.status === "refused" && outcome.problems.includes(problemWords("format.referenceVideo")));
    const stored = await getSession(db.sql, ADMIN, { sessionId: session.id });
    assert.equal(stored.status, "draft");
    assert.ok(stored.lastRefusal.includes(problemWords("format.referenceVideo")), "the refusal is kept on the session");
    assert.equal(await countRequests(), requestsBefore, "no engine request was created by this refused start");
  });

  test("a complete session starts one engine request, unless the engine is not connected; then it takes no more changes", async () => {
    const session = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Complete" });
    const intro = await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Same pacing as this reel, for our blender.", beatRole: null });
    const store = memoryStore();
    const stored = await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: intro.messageId, fileName: "C:\\Downloads\\reel.mp4", purpose: "reference_video", base64: MP4 }, { files: store });
    assert.equal(stored.status, "stored");
    assert.equal(store.puts.length, 1);
    assert.match(store.puts[0] ?? "", new RegExp(`^${WS}/${BRAND}/content-factory/${session.id}/[0-9a-f]{64}\\.mp4$`));
    const second = await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: intro.messageId, fileName: "b.mp4", purpose: "reference_video", base64: MP4 }, { files: store });
    assert.equal(second.status, "refused", "one reference per session");
    await attachSource(db.sql, ADMIN, { sessionId: session.id, messageId: intro.messageId, brandId: BRAND, page: "page", recordId: "page_cf_1" });
    await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Your smoothie is lying to you.", beatRole: "hook" });
    await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Send BLEND for the link.", beatRole: "cta" });
    await saveSettings(db.sql, ADMIN, { sessionId: session.id, budgetUsd: 4, maxSeconds: 30, language: "en", priority: "normal", keepGenes: ["pacing"] });
    await assert.rejects(
      saveSettings(db.sql, ADMIN, { sessionId: session.id, brandId: null, budgetUsd: 4, maxSeconds: 30, language: "en", priority: "normal", keepGenes: [] }),
      /cannot change once a file is attached/,
    );

    const detail = await getSession(db.sql, ADMIN, { sessionId: session.id });
    const file = detail.messages[0]?.attachments.find((item) => item.kind === "file");
    assert.ok(file && file.kind === "file");
    assert.equal(file.fileName, "reel.mp4");
    assert.equal(file.mediaType, "video/mp4");

    const offline = await startRun(db.sql, ADMIN, { sessionId: session.id }, { readiness: notConnectedPorts() });
    assert.equal(offline.status, "refused");
    assert.ok(offline.status === "refused" && offline.problems.length === 0 && offline.notConnected.some((reason) => reason.startsWith("OpenRouter:")));
    assert.equal((await getSession(db.sql, ADMIN, { sessionId: session.id })).status, "draft");

    await assert.rejects(startRun(db.sql, MEMBER, { sessionId: session.id }, { readiness: readyPorts() }), { message: ADMIN_REFUSAL });
    const started = await startRun(db.sql, ADMIN, { sessionId: session.id }, { readiness: readyPorts() });
    assert.equal(started.status, "started");
    if (started.status !== "started") return;
    const engineStatus = await engineRequestStatus(db.sql, WS, started.requestId);
    assert.deepEqual(engineStatus, { status: "queued", requestId: started.requestId });
    assert.equal(await engineRequestStatus(db.sql, OTHER_WS, started.requestId), null, "the request lives in the session's workspace only");

    const after = await getSession(db.sql, ADMIN, { sessionId: session.id });
    assert.equal(after.status, "started");
    assert.equal(after.engineRequestId, started.requestId);
    await assert.rejects(startRun(db.sql, ADMIN, { sessionId: session.id }, { readiness: readyPorts() }), { message: STARTED_REFUSAL });
    await assert.rejects(postMessage(db.sql, ADMIN, { sessionId: session.id, text: "one more", beatRole: null }), { message: STARTED_REFUSAL });

    const run = await readRun(db.sql, ADMIN, { sessionId: session.id });
    assert.equal(run.stage, "started");
    if (run.stage !== "started") return;
    assert.equal(run.feed.requestId, started.requestId);
    assert.equal(run.feed.active, true, "a queued request is polled");
    assert.equal(run.canRevise, false, "a queued video is not revised");
    const tooSoon = await reviseSession(db.sql, ADMIN, { sessionId: session.id });
    assert.equal(tooSoon.status, "refused");
    assert.equal((await getSession(db.sql, ADMIN, { sessionId: session.id })).status, "started");

    await db.sql`update engine_requests set status = 'rejected' where organization_id = ${WS} and id = ${started.requestId}`;
    const opened = await reviseSession(db.sql, ADMIN, { sessionId: session.id });
    assert.equal(opened.status, "draft");
    if (opened.status !== "draft") return;
    assert.equal(opened.priorRequestId, started.requestId);
    await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Make the hook shorter.", beatRole: null });
    const next = await startRun(db.sql, ADMIN, { sessionId: session.id }, { readiness: readyPorts() });
    assert.equal(next.status, "started");
    if (next.status !== "started") return;
    assert.notEqual(next.requestId, started.requestId);
    const revised = await getSession(db.sql, ADMIN, { sessionId: session.id });
    assert.equal(revised.engineRequestId, next.requestId);
    const kept = await engineRequestStatus(db.sql, WS, started.requestId);
    assert.equal(kept?.status, "failed", "the first request stays stored");
    assert.equal(run.feed.cards.find((card) => card.id === "script")?.status, "waiting", "intake is queued");
    assert.match(run.referenceNote, /deletes the source media after the analysis/);
    await assert.rejects(readRun(db.sql, OTHER_ADMIN, { sessionId: session.id }), { message: SESSION_REFUSAL });
  });
});
