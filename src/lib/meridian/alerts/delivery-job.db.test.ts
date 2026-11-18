// The alert.deliver job on a real Postgres (PGlite, or MERIDIAN_PG_TEST_URL), with fake transports only. No test reaches the network:
// the one test that runs the job executor's production wiring replaces global fetch with a counting fixture.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Sql } from "../learning/store.ts";
import type { Transport, TransportRequest } from "../providers/http.ts";
import { runAlertDelivery } from "./delivery-job.ts";
import { MAX_DELIVERY_ATTEMPTS } from "./lifecycle.ts";

const ORG = "org_alerts";
const OTHER = "org_alerts_other";
const TARGET = "https://hooks.example.test/alerts";

let db: TestDatabase;
let sql: Sql;
let alertSeq = 0;

before(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await seedWorkspace(sql, ORG);
  await seedWorkspace(sql, OTHER);
});

after(async () => {
  await db.close();
});

async function newAlert(organizationId = ORG): Promise<string> {
  alertSeq += 1;
  const id = `alert_${alertSeq}`;
  await sql`
    insert into alert_events (id, organization_id, code, severity, detail, delivery_status)
    values (${id}, ${organizationId}, ${`code_${alertSeq}`}, 'warning', 'The queue is backing up.', 'queued')
  `;
  return id;
}

function answering(answer: number | Error): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    if (answer instanceof Error) throw answer;
    return { status: answer, body: "{}", headers: {} };
  };
  return { transport, calls };
}

async function attemptsOf(alertId: string) {
  return sql<{ id: string; status: string }>`select id, status from delivery_attempts where alert_id = ${alertId} order by id`;
}

async function statusOf(alertId: string): Promise<string | undefined> {
  return (await sql<{ delivery_status: string }>`select delivery_status from alert_events where id = ${alertId}`)[0]?.delivery_status;
}

describe("alert delivery", () => {
  it("a 2xx is sent once, with the Idempotency-Key and the alert id, and recorded as sent", async () => {
    const alertId = await newAlert();
    const { transport, calls } = answering(200);
    assert.equal(await runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, transport), "sent");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers["idempotency-key"], `${alertId}:1`);
    assert.equal((JSON.parse(String(calls[0]?.body)) as { id: string }).id, alertId);
    assert.deepEqual((await attemptsOf(alertId)).map((row) => [row.id, row.status]), [[`${alertId}:1`, "sent"]]);
    assert.equal(await statusOf(alertId), "sent");
  });

  it("a second delivery of an alert already sent sends nothing", async () => {
    const alertId = await newAlert();
    await runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, answering(200).transport);
    const again = answering(200);
    assert.equal(await runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, again.transport), "sent");
    assert.equal(again.calls.length, 0);
    assert.equal((await attemptsOf(alertId)).length, 1);
  });

  it("a timeout is uncertain: the key was sent, the job ends without a retry, and no later job sends it again", async () => {
    const alertId = await newAlert();
    const first = answering(new Error("Provider request timed out after 30 seconds."));
    assert.equal(await runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, first.transport), "uncertain");
    assert.equal(first.calls.length, 1, "sent once, not retried");
    assert.equal(first.calls[0]?.headers["idempotency-key"], `${alertId}:1`);
    assert.deepEqual((await attemptsOf(alertId)).map((row) => row.status), ["uncertain"]);
    assert.equal(await statusOf(alertId), "uncertain");
    const later = answering(200);
    assert.equal(await runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, later.transport), "uncertain");
    assert.equal(later.calls.length, 0, "an uncertain attempt is not re-sent");
  });

  it("a 5xx is uncertain too, since the endpoint may have taken it", async () => {
    const alertId = await newAlert();
    const { transport, calls } = answering(503);
    assert.equal(await runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, transport), "uncertain");
    assert.equal(calls.length, 1);
    assert.equal(await statusOf(alertId), "uncertain");
  });

  it("a 4xx is failed and retried by the queue, up to the limit, then dead with nothing more sent", async () => {
    const alertId = await newAlert();
    const { transport, calls } = answering(400);
    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await assert.rejects(runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, transport));
      assert.equal(await statusOf(alertId), "failed");
    }
    assert.equal(await runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, transport), "dead");
    assert.equal(await runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, transport), "dead");
    assert.equal(calls.length, MAX_DELIVERY_ATTEMPTS);
    assert.deepEqual(calls.map((call) => call.headers["idempotency-key"]), [1, 2, 3].map((n) => `${alertId}:${n}`));
    assert.equal(await statusOf(alertId), "dead");
  });

  it("a delivery in flight ('sending') is not sent a second time by a racing job", async () => {
    const alertId = await newAlert();
    await sql`insert into delivery_attempts (id, organization_id, alert_id, status) values (${`${alertId}:1`}, ${ORG}, ${alertId}, 'sending')`;
    const { transport, calls } = answering(200);
    assert.equal(await runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, transport), "sending");
    assert.equal(calls.length, 0);
  });

  it("another workspace's alert is never read, claimed or sent by this job", async () => {
    const alertId = await newAlert(OTHER);
    const { transport, calls } = answering(200);
    assert.equal(await runAlertDelivery(sql, { organizationId: ORG, alertId, targetUrl: TARGET }, transport), "missing");
    assert.equal(calls.length, 0);
    assert.equal((await attemptsOf(alertId)).length, 0);
    assert.equal(await statusOf(alertId), "queued");
  });

  it("the status check refuses an attempt state the lifecycle does not know", async () => {
    const alertId = await newAlert();
    await assert.rejects(sql`insert into delivery_attempts (id, organization_id, alert_id, status) values ('bad', ${ORG}, ${alertId}, 'maybe')`);
  });
});

describe("the job executor's alert.deliver wiring", () => {
  let requests: Array<{ url: string; headers: Record<string, string> }>;
  beforeEach(() => {
    requests = [];
    mock.method(globalThis, "fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("{}", { status: 202 });
    }) as typeof fetch);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it("sends through the real transport (no gate), once, with the Idempotency-Key", async () => {
    const { executeJob } = await import("../jobs/execute.ts");
    const alertId = await newAlert();
    const job = {
      id: `job_${alertId}`,
      organization_id: ORG,
      brand_id: null,
      job_type: "alert.deliver",
      payload: JSON.stringify({ organizationId: ORG, alertId, targetUrl: TARGET }),
      attempts: 0,
      max_attempts: 3,
    };
    assert.equal(await executeJob(sql, job), "sent");
    assert.equal(await executeJob(sql, job), "sent");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, TARGET);
    assert.equal(requests[0]?.headers["idempotency-key"], `${alertId}:1`);
  });
});
