// The Claude Code job queue, on the test database: one runner holds one job under a lease; a heartbeat renews it; a runner that stops
// loses it and the job is queued again, then failed after three tries; "done" is believed only when a video was really saved; a
// cancelled job is taken away from its runner; and another workspace sees none of it.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Sql } from "../learning/store.ts";
import { createConnector } from "../mcp/connectors.ts";
import { claudeCodeTools } from "../mcp/claude-code-tools.ts";
import { createProject } from "../mcp/projects.ts";
import type { ConnectorContext } from "../mcp/tools.ts";
import { claimNext, cleanProgress, jobPrompt, LEASE_MS, MAX_ATTEMPTS, modelAlias, reportJob, requeue, RUNNER_ONLINE_MS, runnerSeen, runnerStatus } from "./queue.ts";
import { cancelRequest, completeRequest, createRequest, listRequests } from "./requests.ts";

const WS = "ws_queue";
const OTHER = "ws_queue_other";
const ADMIN = "user_queue_admin";
const BRIEF = { goal: "g", idea: "i", platform: "p", seconds: 20, style: { id: null, label: "s", instructions: [] }, voice: { wanted: false, tone: "" }, language: "en", render: "chat" as const, audience: "" };

async function seedUser(sql: Sql, userId: string, organizationId: string): Promise<void> {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@fixture.example`}, true) on conflict (id) do nothing`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${userId}-${organizationId}`}, ${organizationId}, ${userId}, 'admin')`;
}

describe("the Claude Code job queue", () => {
  let db: TestDatabase;
  let connectorId = "";
  const t0 = new Date("2026-11-16T10:00:00.000Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const make = async (idea: string, extra: { choice?: string; model?: string } = {}) => {
    const made = await createRequest(db.sql, { organizationId: WS, userId: ADMIN, role: "member", brandId: null, source: "idea", idea, now: () => t0, ...extra });
    assert.ok(made.ok);
    return made.request.id;
  };
  const statusOf = async (id: string) => (await listRequests(db.sql, WS, 50)).find((request) => request.id === id);
  const drain = async () => { await db.sql`update claude_code_requests set status = 'cancelled' where organization_id = ${WS} and status in ('open', 'running')`; };
  const saveVideo = async (projectId: string) => {
    await db.sql`
      insert into mcp_files (id, organization_id, brand_id, connector_id, project_id, kind, storage_key, media_type, byte_size, sha256, details)
      values (${`file_${projectId}`}, ${WS}, null, ${connectorId}, ${projectId}, 'video', ${`k/${projectId}`}, 'video/mp4', 10, ${'a'.repeat(64)}, '{}'::jsonb)
    `;
  };

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS);
    await seedWorkspace(db.sql, OTHER);
    await seedUser(db.sql, ADMIN, WS);
    connectorId = (await createConnector(db.sql, { organizationId: WS, userId: ADMIN, name: "runner" })).connector.id;
  });
  after(async () => db.close());

  it("gives the oldest waiting job to one runner, with the chosen model and a session of its own", async () => {
    const first = await make("The first idea to make", { model: "best" });
    await make("The second idea to make");
    const job = await claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(1000) });
    assert.ok(job);
    assert.equal(job.requestId, first);
    assert.equal(job.model, "opus");
    assert.equal(job.attempt, 1);
    assert.match(job.sessionId, /^[0-9a-f-]{36}$/);
    assert.match(job.prompt, new RegExp(`requestId "${first}"`));
    assert.match(job.prompt, /do not ask/);
    assert.match(job.prompt, /budgetUsd 0/);
    const row = await statusOf(first);
    assert.equal(row?.status, "running");
    assert.equal(row?.runnerName, "laptop");
    assert.equal(await claimNext(db.sql, { organizationId: OTHER, runnerName: "stranger", now: at(1000) }), null);
    await drain();
  });

  it("never gives one job to two runners", async () => {
    const id = await make("Only one runner may make this");
    const [a, b] = await Promise.all([
      claimNext(db.sql, { organizationId: WS, runnerName: "a", now: at(1000) }),
      claimNext(db.sql, { organizationId: WS, runnerName: "b", now: at(1000) }),
    ]);
    assert.equal([a, b].filter((job) => job?.requestId === id).length, 1);
    await drain();
  });

  it("renews the lease on a heartbeat, and hears only the runner that holds the job", async () => {
    const id = await make("A job that takes a while");
    const job = (await claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(0) }))!;
    const beat = await reportJob(db.sql, { organizationId: WS, requestId: id, leaseToken: job.leaseToken, state: "heartbeat", now: at(LEASE_MS - 1000) });
    assert.deepEqual(beat, { ok: true, status: "running", message: "Lease renewed." });
    // Past the first lease, but inside the renewed one: still this runner's.
    assert.equal(await claimNext(db.sql, { organizationId: WS, runnerName: "other", now: at(LEASE_MS + 1000) }), null);
    assert.equal((await reportJob(db.sql, { organizationId: WS, requestId: id, leaseToken: "wrong", state: "done", now: at(2000) })).ok, false);
    assert.equal((await reportJob(db.sql, { organizationId: OTHER, requestId: id, leaseToken: job.leaseToken, state: "done", now: at(2000) })).ok, false);
    await drain();
  });

  it("queues a job again when its runner stops, and fails it after three tries", async () => {
    const id = await make("A job whose runner keeps stopping");
    let now = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const job = await claimNext(db.sql, { organizationId: WS, runnerName: "flaky", now: at(now) });
      assert.equal(job?.requestId, id);
      assert.equal(job?.attempt, attempt);
      now += LEASE_MS + 1000;
    }
    assert.equal(await claimNext(db.sql, { organizationId: WS, runnerName: "flaky", now: at(now) }), null);
    const row = await statusOf(id);
    assert.equal(row?.status, "failed");
    assert.match(row?.lastError ?? "", /stopped answering/);
    // A late report from the runner that lost it is not heard.
    assert.equal(await requeue(db.sql, { organizationId: OTHER, id, now: at(now) }), false);
    assert.equal(await requeue(db.sql, { organizationId: WS, id, now: at(now) }), true);
    assert.equal((await statusOf(id))?.status, "open");
    await drain();
  });

  it("believes 'done' only when a video was saved to the request's project", async () => {
    const noProject = await make("Claude Code said done but made nothing");
    const jobA = (await claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(0) }))!;
    assert.equal((await reportJob(db.sql, { organizationId: WS, requestId: noProject, leaseToken: jobA.leaseToken, state: "done", now: at(1000) })).ok && (await statusOf(noProject))?.status, "failed");
    assert.match((await statusOf(noProject))?.lastError ?? "", /never created the project/);

    const noVideo = await make("Claude Code made a project but no video");
    const jobB = (await claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(2000) }))!;
    const projectB = await createProject(db.sql, { organizationId: WS, brandId: null, connectorId, title: "B", mode: "orchestrator", brief: BRIEF, budgetUsd: 0 });
    assert.equal(await completeRequest(db.sql, WS, noVideo, { id: projectB.id, brandId: null }), true);
    assert.equal((await statusOf(noVideo))?.status, "running", "a runner's job stays running until the runner reports");
    await reportJob(db.sql, { organizationId: WS, requestId: noVideo, leaseToken: jobB.leaseToken, state: "done", now: at(3000) });
    assert.equal((await statusOf(noVideo))?.status, "failed");
    assert.match((await statusOf(noVideo))?.lastError ?? "", /no video was saved/);

    const real = await make("Claude Code made and saved the video");
    const jobC = (await claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(4000) }))!;
    const projectC = await createProject(db.sql, { organizationId: WS, brandId: null, connectorId, title: "C", mode: "orchestrator", brief: BRIEF, budgetUsd: 0 });
    await completeRequest(db.sql, WS, real, { id: projectC.id, brandId: null });
    await saveVideo(projectC.id);
    const done = await reportJob(db.sql, { organizationId: WS, requestId: real, leaseToken: jobC.leaseToken, state: "done", now: at(5000) });
    assert.deepEqual(done, { ok: true, status: "done", message: "Recorded as done." });
    assert.equal((await statusOf(real))?.status, "done");

    const scripts = await make("Three hooks for a mug", { choice: "scripts" });
    const jobD = (await claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(6000) }))!;
    assert.match(jobD.prompt, /Do not render a video/);
    const projectD = await createProject(db.sql, { organizationId: WS, brandId: null, connectorId, title: "D", mode: "orchestrator", brief: BRIEF, budgetUsd: 0 });
    await completeRequest(db.sql, WS, scripts, { id: projectD.id, brandId: null });
    await reportJob(db.sql, { organizationId: WS, requestId: scripts, leaseToken: jobD.leaseToken, state: "done", now: at(7000) });
    assert.equal((await statusOf(scripts))?.status, "done", "scripts need no video");
  });

  it("records a failure with its reason, and takes a cancelled job away from its runner", async () => {
    const failed = await make("A job Claude Code could not finish");
    const job = (await claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(0) }))!;
    await reportJob(db.sql, { organizationId: WS, requestId: failed, leaseToken: job.leaseToken, state: "failed", error: "  Claude Code is not\n signed in.  ", now: at(1000) });
    assert.equal((await statusOf(failed))?.lastError, "Claude Code is not signed in.");

    const cancelled = await make("A job the person cancels while it runs");
    const held = (await claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(2000) }))!;
    assert.equal(await cancelRequest(db.sql, { organizationId: WS, role: "member", id: cancelled }), true);
    const beat = await reportJob(db.sql, { organizationId: WS, requestId: cancelled, leaseToken: held.leaseToken, state: "heartbeat", now: at(3000) });
    assert.equal(beat.ok, false);
    assert.match(beat.ok ? "" : beat.reason, /Stop working on it/);
  });

  it("shows a runner as online only while it keeps checking in, with what its checks found", async () => {
    assert.deepEqual(await runnerStatus(db.sql, OTHER, at(0)), { online: false, name: null, lastSeenAt: null, problems: [], runners: [] });
    await runnerSeen(db.sql, { organizationId: WS, connectorId, name: "laptop", checks: { problems: ["ffmpeg is not installed."] }, now: at(0) });
    const online = await runnerStatus(db.sql, WS, at(1000));
    assert.equal(online.online, true);
    assert.deepEqual(online.problems, ["ffmpeg is not installed."]);
    assert.equal((await runnerStatus(db.sql, WS, at(RUNNER_ONLINE_MS + 1000))).online, false);
  });

  it("lists every computer that is running a runner, not only the most recent", async () => {
    await runnerSeen(db.sql, { organizationId: WS, connectorId, name: "laptop", checks: { problems: [] }, now: at(10_000) });
    await runnerSeen(db.sql, { organizationId: WS, connectorId, name: "desktop", checks: { problems: [] }, now: at(12_000) });
    await runnerSeen(db.sql, { organizationId: WS, connectorId, name: "old-mac", checks: { problems: [] }, now: at(-10 * RUNNER_ONLINE_MS) });
    const status = await runnerStatus(db.sql, WS, at(13_000));
    assert.equal(status.name, "desktop", "the top-level fields stay the most recently seen runner");
    assert.equal(status.online, true);
    assert.deepEqual(status.runners.map((runner) => [runner.name, runner.online]), [["desktop", true], ["laptop", true], ["old-mac", false]]);
    assert.deepEqual((await runnerStatus(db.sql, OTHER, at(13_000))).runners, []);
  });

  it("gives each of several waiting jobs to exactly one of two runners that ask at the same moment", async () => {
    await drain();
    const ids = [await make("Concurrent one"), await make("Concurrent two"), await make("Concurrent three")];
    const taken: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const [a, b] = await Promise.all([
        claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(20_000 + round) }),
        claimNext(db.sql, { organizationId: WS, runnerName: "desktop", now: at(20_000 + round) }),
      ]);
      for (const job of [a, b]) if (job) taken.push(job.requestId);
    }
    assert.deepEqual([...taken].sort(), [...ids].sort(), "every job was taken once, none twice");
    await drain();
  });

  it("stores what a job is doing with each heartbeat, and the turns and time at the end, never a link", async () => {
    await drain();
    const id = await make("A job that reports progress");
    const job = (await claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(0) }))!;
    await reportJob(db.sql, { organizationId: WS, requestId: id, leaseToken: job.leaseToken, state: "heartbeat", progress: "Rendering", now: at(1000) });
    assert.equal((await statusOf(id))?.progress, "Rendering");
    await reportJob(db.sql, { organizationId: WS, requestId: id, leaseToken: job.leaseToken, state: "heartbeat", now: at(2000) });
    assert.equal((await statusOf(id))?.progress, "Rendering", "a heartbeat without a label keeps the last one");
    await reportJob(db.sql, { organizationId: WS, requestId: id, leaseToken: job.leaseToken, state: "heartbeat", progress: "curl https://x.example/api/mcp/mrd_ABCDEFGHIJKLMNOP", now: at(3000) });
    assert.equal((await statusOf(id))?.progress, "", "a label with a link is dropped");
    await reportJob(db.sql, { organizationId: WS, requestId: id, leaseToken: job.leaseToken, state: "failed", error: "stopped", progress: "Saving the video", turns: 14, durationMs: 61_500, now: at(4000) });
    const ended = await statusOf(id);
    assert.equal(ended?.progress, "Saving the video");
    assert.equal(ended?.turns, 14);
    assert.equal(ended?.durationMs, 61_500);
    assert.equal(await requeue(db.sql, { organizationId: WS, id, now: at(5000) }), true);
    const again = await statusOf(id);
    assert.deepEqual([again?.progress, again?.turns, again?.durationMs], ["", null, null], "a new attempt starts with nothing recorded");
    const unknown = (await claimNext(db.sql, { organizationId: WS, runnerName: "laptop", now: at(6000) }))!;
    await reportJob(db.sql, { organizationId: WS, requestId: id, leaseToken: unknown.leaseToken, state: "failed", error: "x", turns: -1, now: at(7000) });
    assert.equal((await statusOf(id))?.turns, null, "a count that is not a whole number of at least 0 stays unknown");
    await drain();
  });

  it("keeps a progress label to one short line", () => {
    assert.equal(cleanProgress("  Rendering\n now "), "Rendering now");
    assert.equal(cleanProgress("x".repeat(500)).length, 120);
    assert.equal(cleanProgress("see http://example.com"), "");
    assert.equal(cleanProgress(undefined), "");
  });

  it("serves the runner through the connector tools, and gives no job to a runner that is not ready", async () => {
    await drain();
    const id = await make("A job for the runner tools");
    const context = { sql: db.sql, connector: { id: connectorId, organizationId: WS, role: "member" }, origin: "", now: () => at(0), linkSecret: null, ports: {} } as unknown as ConnectorContext;
    const tools = new Map(claudeCodeTools().map((tool) => [tool.name, tool as unknown as { run(context: ConnectorContext, input: unknown): Promise<{ text: string; isError?: boolean; data?: { job?: { requestId: string; leaseToken: string } | null } }> }]));
    const notReady = await tools.get("meridian_runner_next")!.run(context, { runner: "laptop", problems: ["Claude Code is not signed in."], take: true });
    assert.equal(notReady.data?.job, null);
    assert.equal((await statusOf(id))?.status, "open");
    const taken = await tools.get("meridian_runner_next")!.run(context, { runner: "laptop", problems: [], take: true });
    assert.equal(taken.data?.job?.requestId, id);
    const empty = await tools.get("meridian_runner_next")!.run(context, { runner: "laptop", problems: [], take: true });
    assert.equal(empty.data?.job, null);
    const report = await tools.get("meridian_runner_report")!.run(context, { requestId: id, leaseToken: taken.data!.job!.leaseToken, state: "failed", error: "stopped" });
    assert.match(report.text, /Recorded as failed/);
    const late = await tools.get("meridian_runner_report")!.run(context, { requestId: id, leaseToken: taken.data!.job!.leaseToken, state: "heartbeat" });
    assert.equal(late.isError, true);
  });

  it("uses Claude Code's own model names, and falls back to the default for an unknown one", () => {
    assert.equal(modelAlias("auto"), "sonnet");
    assert.equal(modelAlias("best"), "opus");
    assert.equal(modelAlias("fast"), "haiku");
    assert.equal(modelAlias("something-else"), "sonnet");
    assert.doesNotMatch(jobPrompt({ requestId: "ccr_x", choice: "auto" }), /api\/mcp/);
  });
});
