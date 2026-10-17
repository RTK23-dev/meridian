// The reconcile_holds maintenance job (contract v9): its job type is routed to the runtime's job, not to a stage, it settles the held calls
// of the job's workspace through the readers the composition gives, and it is refused as not implemented when the runtime has none.
// The database is the test database; no provider is called.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { budgetReservationSchema, EngineError, newId } from "../contracts/index.ts";
import { authorizeCall } from "../budget/reserve.ts";
import { reconcileCall } from "../budget/reconcile.ts";
import { withReservationLedger, withWorkspaceLedger } from "./sql-ledger-store.ts";
import { executeEngineJob } from "./dispatch.ts";
import type { ExecutableJob } from "../../lib/meridian/jobs/execute.ts";
import { ENGINE_MAINTENANCE_JOBS, maintenanceJobOf } from "./registry.ts";
import { createEngineRuntime } from "./runtime.ts";
import { notConnectedWorkspaceBudget } from "./handlers/estimate-reserve.ts";
import { createGateway } from "../gateway/gateway.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";

const NOW = "2026-10-17T10:00:00.000Z";
const OLD = "2026-10-17T09:00:00.000Z";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

/** A workspace with one held call whose provider named it (a generation id), so the job can settle it from its bill. */
async function heldWorkspace(): Promise<{ organizationId: string; entryKey: string }> {
  const organizationId = `ws_maint_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const requestId = newId("req_");
  const reservationId = newId("res_");
  await seedWorkspace(db.sql, organizationId);
  await db.sql`
    insert into engine_requests (id, organization_id, format_id, priority, status, state)
    values (${requestId}, ${organizationId}, 'fmt_maintenance', 'normal', 'running', '{}')
  `;
  const reservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId,
    requestId,
    workspaceId: organizationId,
    mode: "cap",
    lines: [{ stage: "voice", estimateUsd: 1 }],
    estimateUsd: 1,
    redoAllowanceUsd: 0,
    reservedUsd: 1,
    state: "reserved",
    createdAt: "2026-10-17T08:00:00.000Z",
  });
  await withWorkspaceLedger(db.sql, organizationId, (store) => store.createReservation(reservation));
  const entryKey = `maint:${organizationId}`;
  await withReservationLedger(db.sql, organizationId, reservationId, (store) =>
    authorizeCall(store, {
      reservationId,
      stage: "voice",
      provider: "openrouter",
      model: "elevenlabs/eleven-v4",
      estimateUsd: 0.02,
      idempotencyKey: entryKey,
      at: OLD,
    }),
  );
  await withReservationLedger(db.sql, organizationId, reservationId, (store) =>
    reconcileCall(store, { idempotencyKey: entryKey, providerRef: "gen-maint-1" }),
  );
  return { organizationId, entryKey };
}

function jobFor(organizationId: string, jobType: string): ExecutableJob {
  return {
    id: globalThis.crypto.randomUUID(),
    organization_id: organizationId,
    brand_id: null,
    job_type: jobType,
    payload: "{}",
    attempts: 0,
    max_attempts: 3,
  };
}

/** A runtime with no provider reached: the gateway has no key, and the readers are the test's. */
function runtimeWith(holdReaders: Parameters<typeof createEngineRuntime>[0]["holdReaders"]) {
  const gateway = createGateway({
    transport: async () => {
      throw new Error("no provider is called in this test");
    },
    credentials: {
      get: async () => ({ status: "not_connected" as const, reason: "no key in this test" }),
    },
  });
  return createEngineRuntime({
    sql: db.sql,
    gateway,
    workspaceBudget: notConnectedWorkspaceBudget,
    now: () => NOW,
    ...(holdReaders === undefined ? {} : { holdReaders }),
  });
}

describe("the reconcile_holds maintenance job (contract v9)", () => {
  it("maps its job type to the job, and no stage job type to it", () => {
    assert.equal(ENGINE_MAINTENANCE_JOBS.reconcile_holds, "engine.reconcile_holds");
    assert.equal(maintenanceJobOf("engine.reconcile_holds"), "reconcile_holds");
    assert.equal(maintenanceJobOf("engine.plan"), null);
    assert.equal(maintenanceJobOf("engine.poll"), null);
  });

  it("settles the workspace's held call from its bill, and reports what it did", async () => {
    const { organizationId, entryKey } = await heldWorkspace();
    const runtime = runtimeWith({ openrouter: async () => ({ status: "billed", usd: 0.0031 }) });

    const result = await executeEngineJob(db.sql, jobFor(organizationId, "engine.reconcile_holds"), runtime);
    assert.equal(result, "reconciled:settled=1,open=0,operator=0");
    const rows = await db.sql<{ settlement: string | null; actual_usd: string | number | null }>`
      select settlement, actual_usd from engine_ledger where organization_id = ${organizationId} and idempotency_key = ${entryKey}
    `;
    assert.equal(rows[0]?.settlement, "billed");
    assert.equal(Number(rows[0]?.actual_usd), 0.0031);
  });

  it("is refused as not implemented, and nothing is read, when the runtime has no reader", async () => {
    const { organizationId } = await heldWorkspace();
    const runtime = runtimeWith(undefined);
    await assert.rejects(
      executeEngineJob(db.sql, jobFor(organizationId, "engine.reconcile_holds"), runtime),
      (error: unknown) => error instanceof EngineError && error.kind === "not_implemented",
    );
  });
});
