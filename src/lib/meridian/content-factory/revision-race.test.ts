// Review item 9: two revisions of the same delivered video, asked at the same moment, must not both reopen the session. On PostgreSQL
// (MERIDIAN_PG_TEST_URL) the two calls run in two transactions, and the request row's lock serializes them; on PGlite the connection
// serializes them. Either way exactly one revision is saved and the other is refused, and the session keeps one prior request.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { engineRequestStatus, stagesNeeded, type EngineReadinessPorts } from "../../../engine/api/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Sql } from "../learning/store.ts";
import type { ContentFactoryFileStore } from "./files.ts";
import { createSession, getSession, postMessage, reviseSession, saveSettings, attachSource, startRun, uploadFile } from "./service.ts";

const WS = "ws_race";
const BRAND = "brand_race";
const ADMIN = "user_race_admin";

const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]).toString("base64");

async function seedUser(sql: Sql, userId: string): Promise<void> {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@fixture.example`}, true)`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${userId}`}, ${WS}, ${userId}, 'admin')`;
}

function memoryStore(): ContentFactoryFileStore {
  return {
    async ready() {
      return { status: "ready" };
    },
    async put() {
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

describe("review item 9: a revision racing a revision", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
    await seedUser(db.sql, ADMIN);
    await db.sql`
      insert into products (id, brand_id, name, description, benefits, price, created_by)
      values ('prod_race_1', ${BRAND}, 'Blender X', 'A quiet blender', 'quiet; fast', '$89', 'test')
    `;
    await db.sql`
      insert into theme_pages (id, organization_id, brand_id, name, niche, platform, style_kit_id, voice_kit_id)
      values ('page_race_1', ${WS}, ${BRAND}, 'Kitchen hacks', 'kitchen', 'instagram', 'style_race_1', 'voice_race_1')
    `;
  });

  after(async () => {
    await db.close();
  });

  test("two revisions of one delivered video: one is saved, the other is refused, and the session keeps one prior request", async () => {
    const session = await createSession(db.sql, ADMIN, { organizationId: WS, brandId: BRAND, title: "Race" });
    const intro = await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Same pacing as this reel, for our blender.", beatRole: null });
    await uploadFile(db.sql, ADMIN, { sessionId: session.id, messageId: intro.messageId, fileName: "reel.mp4", purpose: "reference_video", base64: MP4 }, { files: memoryStore() });
    await attachSource(db.sql, ADMIN, { sessionId: session.id, messageId: intro.messageId, brandId: BRAND, page: "page", recordId: "page_race_1" });
    await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Your smoothie is lying to you.", beatRole: "hook" });
    await postMessage(db.sql, ADMIN, { sessionId: session.id, text: "Send BLEND for the link.", beatRole: "cta" });
    await saveSettings(db.sql, ADMIN, { sessionId: session.id, budgetUsd: 4, maxSeconds: 30, language: "en", priority: "normal", keepGenes: ["pacing"] });
    const started = await startRun(db.sql, ADMIN, { sessionId: session.id }, { readiness: readyPorts() });
    assert.equal(started.status, "started", JSON.stringify(started));
    if (started.status !== "started") return;

    // The engine delivers the video: its request is delivered and has a manifest. The state is the engine's own, with one field set.
    const [row] = await db.sql<{ state: string }>`select state from engine_requests where id = ${started.requestId} and organization_id = ${WS}`;
    const state = JSON.parse(row?.state ?? "{}") as Record<string, unknown>;
    state.manifestId = "man_race_1";
    await db.sql`update engine_requests set status = 'delivered', state = ${JSON.stringify(state)} where id = ${started.requestId} and organization_id = ${WS}`;
    assert.equal((await engineRequestStatus(db.sql, WS, started.requestId))?.status, "delivered");

    const outcomes = await Promise.all([
      reviseSession(db.sql, ADMIN, { sessionId: session.id }),
      reviseSession(db.sql, ADMIN, { sessionId: session.id }),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["draft", "refused"], JSON.stringify(outcomes));
    await getSession(db.sql, ADMIN, { sessionId: session.id });
    const [saved] = await db.sql<{ status: string; revision: number; prior_request_ids: string }>`
      select status, revision, prior_request_ids from content_factory_sessions where id = ${session.id} and organization_id = ${WS}
    `;
    assert.equal(saved?.status, "draft");
    assert.equal(Number(saved?.revision), 1, "one revision is saved");
    assert.deepEqual(JSON.parse(saved?.prior_request_ids ?? "[]") as string[], [started.requestId], "the prior request is kept once");
  });
});
