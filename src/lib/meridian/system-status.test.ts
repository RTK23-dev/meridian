import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "./learning/store.ts";
import { readSystemStatus } from "./system-status.ts";

const ORGANIZATION = "org-status-test";
const USER = "user-status-test";

/** Fake values only. None is a key, and none may appear in the status. */
const FAKE_ENV = {
  META_ACCESS_TOKEN: "fake-meta-access-token-for-status-test",
  TIKTOK_ACCESS_TOKEN: "fake-tiktok-access-token-for-status-test",
  GOOGLE_ADS_DEVELOPER_TOKEN: "fake-google-developer-token-for-status-test",
  META_AD_LIBRARY_TOKEN: "fake-ad-library-token-for-status-test",
};

async function withFakeEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prior = { ...process.env };
  Object.assign(process.env, FAKE_ENV);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(FAKE_ENV)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

type Recorded = { text: string; values: unknown[] };

/**
 * A fake database. It answers each status read by the table it names and returns no rows for any other query. It records every
 * query with its values. `fail` makes every query throw, as an unreachable database does.
 */
function fakeSql(answers: { membership?: unknown[]; connections?: unknown[]; heartbeats?: unknown[]; fail?: boolean } = {}) {
  const recorded: Recorded[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    recorded.push({ text, values });
    if (answers.fail) throw new Error("the fake database is unreachable");
    if (text.includes("from memberships")) return answers.membership ?? [];
    if (text.includes("from provider_connections")) return answers.connections ?? [];
    if (text.includes("from process_heartbeats")) return answers.heartbeats ?? [];
    return [];
  }) as unknown as Sql;
  return { sql, recorded };
}

function readsOf(recorded: Recorded[], table: string): Recorded[] {
  return recorded.filter((query) => query.text.includes(`from ${table}`));
}

test("the status has no providers field, and no account token from the environment reaches it", async () => {
  await withFakeEnv(async () => {
    const { sql } = fakeSql({ membership: [{ role: "admin" }] });
    const status = await readSystemStatus({ userId: USER, organizationId: ORGANIZATION, loadSql: async () => sql });
    assert.deepEqual(Object.keys(status).sort(), [
      "connections",
      "database",
      "email",
      "embeddings",
      "integrations",
      "localSemantic",
      "objectStorage",
      "publishing",
      "scheduler",
      "worker",
    ]);
    const text = JSON.stringify(status);
    for (const value of Object.values(FAKE_ENV)) assert.equal(text.includes(value), false);
    assert.equal(text.includes("credentials are present"), false);
  });
});

test("a workspace's connections are read only for a member of that workspace, and for that workspace", async () => {
  const outsider = fakeSql({ membership: [] });
  const outsiderStatus = await readSystemStatus({ userId: USER, organizationId: ORGANIZATION, loadSql: async () => outsider.sql });
  assert.equal(readsOf(outsider.recorded, "provider_connections").length, 0);
  assert.ok(outsiderStatus.connections.every((row) => row.accountId === "" && row.accountName === ""));

  const member = fakeSql({
    membership: [{ role: "member" }],
    connections: [
      { provider: "meta", status: "connected", account_id: "act-1", account_name: "Test account", last_error: "", last_success_at: null, disconnected_at: null },
    ],
  });
  const memberStatus = await readSystemStatus({ userId: USER, organizationId: ORGANIZATION, loadSql: async () => member.sql });
  assert.deepEqual(readsOf(member.recorded, "memberships")[0]?.values, [USER, ORGANIZATION]);
  assert.deepEqual(readsOf(member.recorded, "provider_connections")[0]?.values, [ORGANIZATION]);
  assert.equal(memberStatus.connections.find((row) => row.provider === "meta")?.accountId, "act-1");
});

test("when the database does not answer, the status says so and reads no connection", async () => {
  const { sql, recorded } = fakeSql({ fail: true });
  const status = await readSystemStatus({ userId: USER, organizationId: ORGANIZATION, loadSql: async () => sql });
  assert.equal(status.database, "down");
  assert.equal(readsOf(recorded, "provider_connections").length, 0);
});

test("the worker and scheduler show running only with a heartbeat from the last 30 seconds", async () => {
  const { sql } = fakeSql({
    heartbeats: [
      { name: "worker", beat_at: new Date(Date.now() - 5_000) },
      { name: "scheduler", beat_at: new Date(Date.now() - 120_000) },
    ],
  });
  const status = await readSystemStatus({ userId: USER, organizationId: ORGANIZATION, loadSql: async () => sql });
  assert.equal(status.worker, "running");
  assert.equal(status.scheduler, "stopped");
});
