import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { JournalEntry, RoleCall } from "../claude/journal.ts";
import { EngineError } from "../contracts/index.ts";
import { fixtureId } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { listRoleCalls, manifestRoleCalls, promptVersionsOf, sqlRoleCallJournal } from "./role-call-store.ts";

const MODEL = "anthropic/claude-sonnet-5.5";
const ORG = "ws_role_store";
const OTHER_ORG = "ws_role_store_other";
const REQUEST = fixtureId("req_", 701);
const RESERVATION = fixtureId("res_", 701);
const KEY_A = `sha256:${"a".repeat(64)}`;
const KEY_B = `sha256:${"b".repeat(64)}`;
const KEY_C = `sha256:${"c".repeat(64)}`;

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG);
  await seedWorkspace(db.sql, OTHER_ORG);
  await db.sql`
    insert into engine_requests (id, organization_id, format_id, priority, status, state)
    values (${REQUEST}, ${ORG}, 'fmt_test', 'normal', 'running', '{}')
  `;
  await db.sql`
    insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, created_at)
    values (${RESERVATION}, ${ORG}, ${REQUEST}, 'cap', 'reserved', '[]', 1, 0, 1, now())
  `;
});

after(async () => {
  await db.close();
});

function callFor(key: string, verdict: RoleCall["verdict"], issues: string[] = []): RoleCall {
  return {
    idempotencyKey: key,
    ledgerEntryId: `led_${key.slice(7, 15)}`,
    promptVersion: "segmenter@1",
    model: MODEL,
    answeredBy: verdict === "answered" ? MODEL : null,
    generationId: verdict === "answered" ? `gen-${key.slice(7, 12)}` : null,
    promptTokens: 25873,
    completionTokens: verdict === "answered" ? 612 : 190,
    costUsd: 0.057866,
    verdict,
    issues,
  };
}

function entryFor(key: string, fields: Partial<JournalEntry> & Pick<JournalEntry, "status">): JournalEntry {
  return {
    idempotencyKey: key,
    retryOfKey: null,
    role: "segmenter",
    stage: "analyze_reference",
    promptVersion: "segmenter@1",
    model: MODEL,
    reservationId: RESERVATION,
    call: null,
    answer: null,
    refusedReason: null,
    ...fields,
  };
}

function journal(organizationId = ORG, requestId = REQUEST) {
  return sqlRoleCallJournal(db.sql, { organizationId, requestId });
}

describe("the role call journal", () => {
  it("stores a pending entry, finds it by its key, and holds no answer", async () => {
    await journal().record(entryFor(KEY_A, { status: "pending" }));
    const found = await journal().find(KEY_A);
    assert.equal(found?.status, "pending");
    assert.equal(found?.call, null);
    assert.equal(found?.answer, null);
    assert.equal(found?.role, "segmenter");
    assert.equal(found?.reservationId, RESERVATION);
    assert.equal(await journal().find(KEY_B), null, "an unknown key finds nothing");
  });

  it("moves a pending entry to answered with its RoleCall and answer, and then never changes it", async () => {
    const answer = { segments: [{ segId: "s1", startMs: 0, endMs: 3000 }] };
    await journal().record(entryFor(KEY_B, { status: "pending" }));
    await journal().record(entryFor(KEY_B, { status: "answered", call: callFor(KEY_B, "answered"), answer }));
    const found = await journal().find(KEY_B);
    assert.equal(found?.status, "answered");
    assert.deepEqual(found?.answer, answer);
    assert.equal(found?.call?.generationId, `gen-${KEY_B.slice(7, 12)}`);
    assert.equal(found?.call?.costUsd, 0.0579, "money is stored at four decimals");

    await journal().record(entryFor(KEY_B, { status: "pending" }));
    await journal().record(entryFor(KEY_B, { status: "refused", refusedReason: "reservation is paused" }));
    await journal().record(entryFor(KEY_B, { status: "invalid_answer", call: callFor(KEY_B, "invalid_answer", ["segments.0.shotType: invalid_value"]) }));
    const after = await journal().find(KEY_B);
    assert.equal(after?.status, "answered", "an answered entry is final");
    assert.deepEqual(after?.answer, answer);
  });

  it("keeps a refusal with its reason, then lets the same key move on when the budget allows the call", async () => {
    await journal().record(entryFor(KEY_C, { status: "refused", refusedReason: "call would take the reservation above its limit" }));
    const refused = await journal().find(KEY_C);
    assert.equal(refused?.status, "refused");
    assert.equal(refused?.refusedReason, "call would take the reservation above its limit");
    assert.equal(refused?.call, null);

    await journal().record(entryFor(KEY_C, { status: "pending" }));
    assert.equal((await journal().find(KEY_C))?.status, "pending");
    assert.equal((await journal().find(KEY_C))?.refusedReason, null, "a pending entry has no refusal reason");

    await journal().record(entryFor(KEY_C, { status: "answered", call: callFor(KEY_C, "answered"), answer: { segments: [] } }));
    assert.equal((await journal().find(KEY_C))?.status, "answered");
  });

  it("stores an invalid answer with the paths and codes it failed, and no answer text", async () => {
    const key = `sha256:${"d".repeat(64)}`;
    await journal().record(entryFor(key, { status: "invalid_answer", call: callFor(key, "invalid_answer", ["segments.0.shotType: invalid_value"]) }));
    const found = await journal().find(key);
    assert.equal(found?.status, "invalid_answer");
    assert.equal(found?.answer, null);
    assert.deepEqual(found?.call?.issues, ["segments.0.shotType: invalid_value"]);
    assert.equal(found?.call?.verdict, "invalid_answer");
  });

  it("is invisible to another workspace, and to another request of the same workspace", async () => {
    assert.equal(await journal(OTHER_ORG).find(KEY_A), null);
    assert.deepEqual(await listRoleCalls(db.sql, { organizationId: OTHER_ORG, requestId: REQUEST }), []);
    assert.equal(await journal(ORG, fixtureId("req_", 702)).find(KEY_A), null);
  });

  it("stores an answered call with no provider bill at a null cost, and never writes an estimate as the cost (contract v6)", async () => {
    const key = `sha256:${"0".repeat(64)}`;
    await journal().record(entryFor(key, { status: "pending" }));
    await journal().record(entryFor(key, { status: "answered", call: { ...callFor(key, "answered"), costUsd: null }, answer: { segments: [] } }));
    const found = await journal().find(key);
    assert.equal(found?.status, "answered");
    assert.equal(found?.call?.costUsd, null, "no bill came back, so the cost stays unknown");
  });

  it("refuses an entry that does not fit its status, before anything is written", async () => {
    const key = `sha256:${"e".repeat(64)}`;
    const refuses = (entry: JournalEntry) =>
      assert.rejects(journal().record(entry), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    await refuses(entryFor(key, { status: "answered", call: null, answer: { x: 1 } }));
    await refuses(entryFor(key, { status: "answered", call: callFor(key, "answered"), answer: null }));
    await refuses(entryFor(key, { status: "invalid_answer", call: callFor(key, "answered") }));
    await refuses(entryFor(key, { status: "pending", call: callFor(key, "answered") }));
    await refuses(entryFor(key, { status: "refused", refusedReason: "" }));
    assert.equal(await journal().find(key), null, "nothing was stored");
  });

  it("the database refuses an answered row with no answer, even if the code did not check", async () => {
    await assert.rejects(
      db.sql`
        insert into engine_role_calls (id, organization_id, request_id, reservation_id, stage, role, prompt_version, model,
          idempotency_key, status, ledger_entry_id)
        values ('rc_check_1', ${ORG}, ${REQUEST}, ${RESERVATION}, 'analyze_reference', 'segmenter', 'segmenter@1', ${MODEL},
          ${`sha256:${"f".repeat(64)}`}, 'answered', 'led_x')
      `,
      /violates check constraint/,
    );
  });

  it("lists the entries in the order they were first attempted, and gives the manifest only the billed calls", async () => {
    const orderOrg = "ws_role_order";
    const orderReq = fixtureId("req_", 703);
    const orderRes = fixtureId("res_", 703);
    await seedWorkspace(db.sql, orderOrg);
    await db.sql`
      insert into engine_requests (id, organization_id, format_id, priority, status, state)
      values (${orderReq}, ${orderOrg}, 'fmt_test', 'normal', 'running', '{}')
    `;
    await db.sql`
      insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, created_at)
      values (${orderRes}, ${orderOrg}, ${orderReq}, 'cap', 'reserved', '[]', 1, 0, 1, now())
    `;
    const store = sqlRoleCallJournal(db.sql, { organizationId: orderOrg, requestId: orderReq });
    const withRes = (entry: JournalEntry): JournalEntry => ({ ...entry, reservationId: orderRes });
    await store.record(withRes(entryFor(KEY_A, { status: "pending" })));
    await store.record(withRes(entryFor(KEY_B, { status: "refused", refusedReason: "paused" })));
    await store.record(withRes(entryFor(KEY_A, { status: "invalid_answer", call: callFor(KEY_A, "invalid_answer", ["segments: missing"]) })));
    await store.record(withRes(entryFor(KEY_C, { status: "pending" })));

    const entries = await listRoleCalls(db.sql, { organizationId: orderOrg, requestId: orderReq });
    assert.deepEqual(entries.map((entry) => [entry.idempotencyKey, entry.status]), [
      [KEY_A, "invalid_answer"],
      [KEY_B, "refused"],
      [KEY_C, "pending"],
    ]);
    const billed = manifestRoleCalls(entries);
    assert.deepEqual(billed.map((call) => call.verdict), ["invalid_answer"]);
    assert.deepEqual(billed[0]?.issues, ["segments: missing"]);
    assert.deepEqual(promptVersionsOf(entries), { segmenter: "segmenter@1" });
  });

  it("refuses a role that ran with two prompt versions in one request, since the manifest could name only one", async () => {
    const entries = [
      entryFor(KEY_A, { status: "answered", call: callFor(KEY_A, "answered"), answer: {}, promptVersion: "segmenter@1" }),
      entryFor(KEY_B, { status: "pending", promptVersion: "segmenter@2" }),
    ];
    assert.throws(() => promptVersionsOf(entries), (error: unknown) => error instanceof EngineError && error.kind === "internal");
  });
});
