// Resuming a Claude role call from its persisted record (Video Engine Bible 11, 14.1). These tests run the real client (runRole)
// against PGlite with the SQL journal and the SQL ledger. The gateway answers from recorded fixtures; nothing calls a live API.
// Each test has its own workspace, request and reservation, so keys never collide across tests.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runRole, type RoleDeps } from "../claude/client.ts";
import { RoleAnswerError } from "../claude/errors.ts";
import { segmenter } from "../claude/roles/segmenter.ts";
import { fixture, gatewayFor, json, segmenterInput } from "../claude/test/helpers.ts";
import { budgetReservationSchema, EngineError, type BudgetReservation } from "../contracts/index.ts";
import { fixtureId } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { manifestRoleCalls, listRoleCalls, promptVersionsOf, sqlRoleCallJournal } from "./role-call-store.ts";
import { sqlLedgerStore } from "./sql-ledger-store.ts";

const NOW = "2026-10-14T10:01:00.000Z";
const CREATED = "2026-10-14T10:00:00.000Z";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

type Scope = { organizationId: string; requestId: string; reservationId: string };

/** A fresh workspace, request and reservation for one test. The reservation holds `reservedUsd`. */
async function scopeWith(n: number, reservedUsd: number): Promise<Scope> {
  const scope: Scope = {
    organizationId: `ws_resume_${n}`,
    requestId: fixtureId("req_", 800 + n),
    reservationId: fixtureId("res_", 800 + n),
  };
  await seedWorkspace(db.sql, scope.organizationId);
  await db.sql`
    insert into engine_requests (id, organization_id, format_id, priority, status, state)
    values (${scope.requestId}, ${scope.organizationId}, 'fmt_test', 'normal', 'running', '{}')
  `;
  await sqlLedgerStore(db.sql, scope.organizationId).createReservation(reservationOf(scope, reservedUsd));
  return scope;
}

function reservationOf(scope: Scope, reservedUsd: number): BudgetReservation {
  return budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: scope.reservationId,
    requestId: scope.requestId,
    workspaceId: scope.organizationId,
    mode: "cap",
    lines: [{ stage: "claude_roles", estimateUsd: reservedUsd }],
    estimateUsd: reservedUsd,
    redoAllowanceUsd: 0,
    reservedUsd,
    state: "reserved",
    createdAt: CREATED,
  });
}

/** Raises or lowers a reservation's limit, as an owner's top-up would. Its lines are unchanged. */
async function setLimit(scope: Scope, reservedUsd: number): Promise<void> {
  await sqlLedgerStore(db.sql, scope.organizationId).updateReservation(reservationOf(scope, reservedUsd));
}

/** Dependencies for one run: the gateway answers from the queue, and the journal is this request's. */
function depsFor(scope: Scope, responses: Parameters<typeof gatewayFor>[0]) {
  const { gateway, requests } = gatewayFor(responses);
  const deps: RoleDeps = {
    gateway,
    ledger: sqlLedgerStore(db.sql, scope.organizationId),
    now: () => NOW,
    journal: sqlRoleCallJournal(db.sql, { organizationId: scope.organizationId, requestId: scope.requestId }),
  };
  return { deps, requests };
}

function requestFor(scope: Scope) {
  return { requestId: scope.requestId, workspaceId: scope.organizationId, reservationId: scope.reservationId, input: segmenterInput() };
}

describe("a resumed role call", () => {
  it("reuses a stored answer after a crash, without any call, and the manifest carries the RoleCall", async () => {
    const scope = await scopeWith(1, 1);
    const first = depsFor(scope, [json(200, fixture("openrouter-segmenter-ok"))]);
    const done = await runRole(first.deps, segmenter, requestFor(scope));
    assert.equal(done.status, "done");
    assert.equal(first.requests.length, 1);

    // The job crashed after the answer was stored, before its artifact was written. The resumed run has no response to read.
    const resumed = depsFor(scope, []);
    const again = await runRole(resumed.deps, segmenter, requestFor(scope));
    assert.equal(again.status, "done");
    if (again.status !== "done" || done.status !== "done") return;
    assert.deepEqual(again.value, done.value, "the stored answer is the answer that was billed");
    assert.equal(again.calls.length, 0, "no new call");
    assert.equal(again.resumed.length, 1);
    assert.equal(resumed.requests.length, 0, "the gateway was not asked");

    const entries = await listRoleCalls(db.sql, scope);
    const billed = manifestRoleCalls(entries);
    assert.equal(billed.length, 1);
    assert.equal(billed[0]?.promptVersion, "segmenter@1");
    assert.equal(billed[0]?.model, "anthropic/claude-sonnet-5.5");
    assert.equal(billed[0]?.promptTokens, 25873);
    assert.equal(billed[0]?.completionTokens, 612);
    assert.equal(billed[0]?.costUsd, 0.0579, "stored at four decimals, as the ledger holds it");
    assert.equal(billed[0]?.verdict, "answered");
    assert.deepEqual(promptVersionsOf(entries), { segmenter: "segmenter@1" });
  });

  it("sends only the retry after a first answer that failed its contract and whose retry was refused by the budget", async () => {
    // The first call is billed at 0.05775, so the retry (estimated at 0.082) does not fit in a 0.1 limit.
    const scope = await scopeWith(2, 0.1);
    const first = depsFor(scope, [json(200, fixture("openrouter-segmenter-overlap"))]);
    const refused = await runRole(first.deps, segmenter, requestFor(scope));
    assert.equal(refused.status, "refused");
    assert.equal(refused.calls.length, 1, "the billed first call is on the outcome");
    assert.equal(first.requests.length, 1);

    const entriesAfterRefusal = await listRoleCalls(db.sql, scope);
    assert.deepEqual(entriesAfterRefusal.map((entry) => entry.status), ["invalid_answer", "refused"]);

    // The owner raises the limit. The resumed run must not pay for the first call again: it sends the retry only.
    await setLimit(scope, 1);
    const resumed = depsFor(scope, [json(200, fixture("openrouter-segmenter-ok"))]);
    const done = await runRole(resumed.deps, segmenter, requestFor(scope));
    assert.equal(done.status, "done");
    if (done.status !== "done") return;
    assert.equal(resumed.requests.length, 1, "only the retry is sent");
    assert.equal(done.calls.length, 1);
    assert.equal(done.resumed.length, 1, "the stored first call is used, not called again");
    assert.equal(done.resumed[0]?.verdict, "invalid_answer");
    assert.ok((done.resumed[0]?.issues.length ?? 0) > 0, "the stored first call names the checks its retry answers");

    const entries = await listRoleCalls(db.sql, scope);
    assert.deepEqual(entries.map((entry) => entry.status), ["invalid_answer", "answered"]);
    const billed = manifestRoleCalls(entries);
    assert.equal(billed.length, 2);
    assert.equal(billed[0]?.verdict, "invalid_answer");
    assert.equal(billed[0]?.costUsd, 0.0578, "the first call's cost is kept for the manifest, at four decimals");
    assert.ok((billed[0]?.issues.length ?? 0) > 0, "its failed checks are kept, by path and code");
    assert.equal(billed[1]?.verdict, "answered");
    assert.equal(billed[1]?.costUsd, 0.0579);
  });

  it("makes its first call once a refused call's budget is raised, and the refusal is replaced by the answer", async () => {
    const scope = await scopeWith(3, 0.05);
    const first = depsFor(scope, [json(200, fixture("openrouter-segmenter-ok"))]);
    const refused = await runRole(first.deps, segmenter, requestFor(scope));
    assert.equal(refused.status, "refused");
    assert.equal(first.requests.length, 0, "a refused call is never sent");
    assert.deepEqual((await listRoleCalls(db.sql, scope)).map((entry) => entry.status), ["refused"]);
    assert.deepEqual(manifestRoleCalls(await listRoleCalls(db.sql, scope)), [], "a refusal is not a billed call");

    await setLimit(scope, 1);
    const resumed = depsFor(scope, [json(200, fixture("openrouter-segmenter-ok"))]);
    const done = await runRole(resumed.deps, segmenter, requestFor(scope));
    assert.equal(done.status, "done");
    assert.equal(resumed.requests.length, 1);
    assert.equal(done.resumed.length, 0);
    const entries = await listRoleCalls(db.sql, scope);
    assert.deepEqual(entries.map((entry) => entry.status), ["answered"]);
  });

  it("does not call again for a call that was started and never came back: it reports duplicate, and the hold stays", async () => {
    const scope = await scopeWith(4, 1);
    const crashed = depsFor(scope, []); // the transport has no answer, so the call fails in flight
    await assert.rejects(runRole(crashed.deps, segmenter, requestFor(scope)));
    assert.equal(crashed.requests.length, 1, "the call was attempted once");
    const pending = await listRoleCalls(db.sql, scope);
    assert.deepEqual(pending.map((entry) => entry.status), ["pending"]);
    assert.deepEqual(manifestRoleCalls(pending), [], "a pending call has no answer to record");

    const resumed = depsFor(scope, [json(200, fixture("openrouter-segmenter-ok"))]);
    const again = await runRole(resumed.deps, segmenter, requestFor(scope));
    assert.equal(again.status, "duplicate", "the ledger already holds the key, so no second call is made");
    assert.equal(resumed.requests.length, 0);
  });

  it("fails again without a call when the stored retry was also invalid, with the attempts that were made", async () => {
    const scope = await scopeWith(5, 1);
    const first = depsFor(scope, [json(200, fixture("openrouter-segmenter-overlap")), json(200, fixture("openrouter-segmenter-overlap"))]);
    await assert.rejects(runRole(first.deps, segmenter, requestFor(scope)), (error: unknown) => {
      assert.ok(error instanceof RoleAnswerError);
      assert.equal(error.attempts, 2);
      return true;
    });

    const resumed = depsFor(scope, []);
    await assert.rejects(runRole(resumed.deps, segmenter, requestFor(scope)), (error: unknown) => {
      assert.ok(error instanceof RoleAnswerError, "the stage fails again");
      assert.equal(error.attempts, 2, "both stored calls are counted");
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(resumed.requests.length, 0, "no call is made to fail it again");
  });

  it("refuses a resumed call whose reservation belongs to another request, as not found, before reading the journal", async () => {
    const scope = await scopeWith(6, 1);
    const other = await scopeWith(7, 1);
    const { deps } = depsFor(scope, []);
    await assert.rejects(
      runRole(deps, segmenter, { ...requestFor(scope), reservationId: other.reservationId }),
      (error: unknown) => error instanceof EngineError && error.kind === "not_found",
    );
  });
});
