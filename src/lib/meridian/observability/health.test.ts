import assert from "node:assert/strict";
import test from "node:test";
import { HEARTBEAT_FRESH_MS, PUBLIC_HEALTH_BODY, healthResult, heartbeatState, loadHealthDetail, type HealthDeps } from "./health.ts";
import type { Sql } from "../learning/store.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");

/** Dependencies that fail the test if any of them is called. A signed-out or plain request must not reach them. */
function untouchableDeps(): HealthDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveUserId: async () => {
      calls.push("resolveUserId");
      return null;
    },
    resolveActiveWorkspace: async () => {
      calls.push("resolveActiveWorkspace");
      throw new Error("no workspace lookup for this request");
    },
    loadDetail: async () => {
      calls.push("loadDetail");
      throw new Error("no detail for this request");
    },
  };
}

test("a plain request gets liveness only, and reaches no session, workspace or database code", async () => {
  const deps = untouchableDeps();
  const result = await healthResult(false, deps);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: "ok" });
  assert.deepEqual(result.body, PUBLIC_HEALTH_BODY);
  assert.deepEqual(deps.calls, []);
});

test("a signed-out detail request gets no counts, no statuses and no database answer", async () => {
  const deps = untouchableDeps();
  const result = await healthResult(true, deps);
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: "Unauthorized" });
  const text = JSON.stringify(result.body);
  for (const word of ["jobs", "count", "publishing", "database", "worker", "scheduler", "storage", "providers"]) {
    assert.equal(text.includes(word), false, `a signed-out body must not contain ${word}`);
  }
  assert.deepEqual(deps.calls, ["resolveUserId"], "the detail loader is never called for a signed-out caller");
});

test("a signed-in member gets no counts: detail is for workspace admins only", async () => {
  const deps: HealthDeps = {
    resolveUserId: async () => "user-member",
    resolveActiveWorkspace: async () => ({ organizationId: "org-a", role: "member" }),
    loadDetail: async () => {
      throw new Error("a member must not reach the detail loader");
    },
  };
  const result = await healthResult(true, deps);
  assert.equal(result.status, 403);
  assert.equal(JSON.stringify(result.body).includes("jobs"), false);
});

test("a membership with an unknown role gets no detail either", async () => {
  const deps: HealthDeps = {
    resolveUserId: async () => "user-odd",
    resolveActiveWorkspace: async () => ({ organizationId: "org-a", role: "superuser" }),
    loadDetail: async () => {
      throw new Error("an unreadable role must not reach the detail loader");
    },
  };
  assert.equal((await healthResult(true, deps)).status, 403);
});

test("an admin gets detail for their own active workspace only, and no other workspace is asked for", async () => {
  const askedFor: string[] = [];
  const deps: HealthDeps = {
    resolveUserId: async () => "user-admin",
    resolveActiveWorkspace: async () => ({ organizationId: "org-a", role: "admin" }),
    loadDetail: async (organizationId) => {
      askedFor.push(organizationId);
      return { database: "up", jobs: [{ status: "queued", count: 2 }] };
    },
  };
  const result = await healthResult(true, deps);
  assert.equal(result.status, 200);
  assert.deepEqual(askedFor, ["org-a"]);
  assert.deepEqual(result.body, { status: "ok", database: "up", jobs: [{ status: "queued", count: 2 }] });
});

/** A stub database. It records each query's text and values and answers from `answer`. */
function stubSql(answer: (text: string, values: unknown[]) => unknown, calls: Array<{ text: string; values: unknown[] }>): Sql {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return Promise.resolve().then(() => answer(text, values));
  };
  return run as unknown as Sql;
}

test("the job counts query is scoped to the one workspace it was given", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = stubSql((text) => {
    if (text.includes("from process_heartbeats")) return [];
    if (text.includes("from jobs")) return [{ status: "queued", count: 1 }];
    if (text.includes("from publishing_queues")) return [];
    return [{ ok: 1 }];
  }, calls);

  const detail = await loadHealthDetail(sql, "org-a", NOW);
  const counted = calls.filter((call) => call.text.includes("from jobs") || call.text.includes("from publishing_queues"));
  assert.equal(counted.length, 2);
  for (const call of counted) {
    assert.match(call.text, /where organization_id = \?/, "the count is filtered by organization");
    assert.deepEqual(call.values, ["org-a"]);
  }
  assert.deepEqual(detail.jobs, [{ status: "queued", count: 1 }]);
});

test("with the database down, nothing reads as a count or as stopped: every value is unknown or null", async () => {
  const sql = stubSql(() => {
    throw new Error("connection refused");
  }, []);
  const detail = await loadHealthDetail(sql, "org-a", NOW);
  assert.deepEqual(detail, { database: "down", worker: "unknown", scheduler: "unknown", jobs: null, publishingQueue: null });
});

test("a failed count reads as unknown (null), not as an empty or zero result", async () => {
  const sql = stubSql((text) => {
    if (text.includes("from process_heartbeats")) return [];
    if (text.includes("from jobs")) throw new Error("relation does not exist");
    if (text.includes("from publishing_queues")) return [];
    return [{ ok: 1 }];
  }, []);
  const detail = await loadHealthDetail(sql, "org-a", NOW);
  assert.equal(detail.jobs, null);
  assert.equal(detail.database, "up");
});

test("a heartbeat is running when fresh, stopped when old, not reported when absent, and unknown when unreadable", () => {
  assert.equal(heartbeatState(undefined, NOW), "not_reported");
  assert.equal(heartbeatState({ beat_at: new Date(NOW - 5_000).toISOString() }, NOW), "running");
  assert.equal(heartbeatState({ beat_at: new Date(NOW - HEARTBEAT_FRESH_MS - 1).toISOString() }, NOW), "stopped");
  assert.equal(heartbeatState({ beat_at: null }, NOW), "unknown");
  assert.equal(heartbeatState({ beat_at: "not a time" }, NOW), "unknown");
});
