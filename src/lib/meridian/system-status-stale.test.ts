import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";
import { readSystemStatus } from "./system-status.ts";
import { sealSecret } from "./oauth/flow.server.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../engine/test/pg-test-db.ts";

// The stale-success rule through the real status read: the real queries on a test database, a real sealed token, a member of the
// workspace, and a stored success at a chosen age. No provider is called and no live success is invented. Date.now is pinned only
// around the status call, so the 24-hour boundary is exact.

const WS = "ws_stale_status";
const USER = "user_stale_status";
const KEY = "stale-status-test-encryption-key";
const NOW = Date.parse("2026-06-15T12:00:00.000Z");

// A literal day, not the constant under test: a changed window must fail this test.
const DAY = 24 * 60 * 60 * 1000;

const AGES: Record<"meta" | "tiktok" | "google", number> = {
  meta: DAY, // exactly one day: still fresh
  tiktok: DAY + 1, // one millisecond past the window: stale
  google: 90 * DAY, // ninety days: stale
};

describe("a stored connection's recorded success, read through the status", () => {
  let db: TestDatabase;
  const priorKey = process.env.TOKEN_ENCRYPTION_KEY;

  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS);
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${USER}, ${USER}, ${`${USER}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values ('m_stale_status', ${WS}, ${USER}, 'member')`;
    for (const provider of ["meta", "tiktok", "google"] as const) {
      const sealed = sealSecret(`${provider}-token-not-real`, KEY);
      assert.equal(typeof sealed, "string", "the fixture token must seal");
      await db.sql`insert into provider_secrets (id, organization_id, provider, sealed_token) values (${`ps_${provider}_stale`}, ${WS}, ${provider}, ${sealed as string})`;
      const succeededAt = new Date(NOW - AGES[provider]).toISOString();
      await db.sql`
        insert into provider_connections (id, organization_id, provider, status, last_success_at)
        values (${`pc_${provider}_stale`}, ${WS}, ${provider}, 'connected', ${succeededAt})
      `;
    }
  });

  after(async () => {
    if (priorKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = priorKey;
    await db.close();
  });

  async function statusAtNow() {
    const pinned = mock.method(Date, "now", () => NOW);
    try {
      return await readSystemStatus({ userId: USER, organizationId: WS, loadSql: async () => db.sql });
    } finally {
      pinned.mock.restore();
    }
  }

  test("a success exactly one day old is still fresh, and it is the only one of the three that reads HEALTHY", async () => {
    const status = await statusAtNow();
    assert.equal(status.connections.find((row) => row.provider === "meta")?.phase, "HEALTHY");
    assert.deepEqual(
      status.connections.filter((row) => row.phase === "HEALTHY").map((row) => row.provider),
      ["meta"],
    );
  });

  test("a success one millisecond past the window is DEGRADED, never HEALTHY", async () => {
    const row = (await statusAtNow()).connections.find((item) => item.provider === "tiktok");
    assert.equal(row?.phase, "DEGRADED");
    assert.equal(row?.detail, "The last successful request is stale.");
  });

  test("a success ninety days old is DEGRADED, and the recorded time is reported as recorded", async () => {
    const row = (await statusAtNow()).connections.find((item) => item.provider === "google");
    assert.equal(row?.phase, "DEGRADED");
    assert.equal(row?.detail, "The last successful request is stale.");
    assert.equal(row?.lastSuccessAt, new Date(NOW - AGES.google).toISOString());
  });

  test("nothing in the status claims a live check, and no token leaks", async () => {
    const text = JSON.stringify(await statusAtNow());
    assert.doesNotMatch(text, /live verified|verified against/i);
    for (const provider of ["meta", "tiktok", "google"]) assert.equal(text.includes(`${provider}-token-not-real`), false);
  });
});
