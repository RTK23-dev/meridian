import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { factoryRunFor, planRowsFor, runRow, stageJob, stubImageProvider, studioTenant, type FactoryTenant } from "../testing/produce-fixtures.ts";
import type { Sql } from "../learning/store.ts";

// The testing runtime enables the image double and the testing artifact store. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

// The stage and the library and review readers use the "@/" alias only through their server modules. The alias hook is registered
// before they are loaded, as the other durable suites do.
enableAppAliases();
const { executeFactoryJob, creativeQaVerdict } = await import("./worker.ts");
const { loadLibraryCreatives } = await import("../library/listing.ts");
const { loadReviewPage } = await import("../reviews/listing.ts");
const { listHeldReservations, releaseExpiredHolds } = await import("../security/held-reservations.ts");

async function produce(sql: Sql, tenant: FactoryTenant, runId: string) {
  return executeFactoryJob(sql, stageJob(tenant, runId, "factory.produce"), { runId });
}

async function reservationsOf(sql: Sql, tenant: FactoryTenant) {
  return sql<{ id: string; status: string; production_job_id: string | null; cost_basis: string | null }>`
    select id, status, production_job_id, cost_basis from budget_reservations
    where organization_id = ${tenant.organizationId} order by created_at asc, id asc
  `;
}

test("a produced image is a creative in Library and Reviews, linked to its run and variant, and its reservation settles", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-produce-ok");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" }, caps: { totalCents: 500 } });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider();
  try {
    assert.equal(await produce(sql, tenant, runId), "variants:1;creatives:1");
  } finally {
    stub.restore();
  }
  assert.equal(stub.state.calls, 1, "the provider was called once");

  const [link] = await sql<{ creative_id: string; variant_id: string; run_id: string }>`
    select creative_id, variant_id, run_id from factory_creatives where run_id = ${runId}
  `;
  assert.ok(link, "the creative is linked to the run");
  assert.equal(link.variant_id, variantId);

  const [creative] = await sql<{ origin: string; status: string; workflow: string }>`
    select origin, status, workflow from creative_records where id = ${link.creative_id}
  `;
  assert.equal(creative?.origin, "generated");
  assert.equal(JSON.parse(creative?.workflow ?? "{}").generationRunId, runId, "the creative records the Factory run that made it");
  assert.notEqual(creative?.status, "approved", "a creative judged with no engine configured is never approved");

  const library = await loadLibraryCreatives(sql, tenant.organizationId, tenant.brandId);
  assert.ok(library.some((row) => row.id === link.creative_id), "the Factory creative is listed in the Library");
  if (creative?.status === "in_review") {
    const reviews = await loadReviewPage(sql, tenant.organizationId, tenant.brandId, { offset: 0, limit: 50 });
    assert.ok(reviews.rows.some((row) => row.creative_id === link.creative_id), "the Factory creative waits in Reviews");
  }

  const [reservation] = await reservationsOf(sql, tenant);
  assert.equal(reservation?.status, "RECONCILED", "the reservation is settled once the creative is recorded");
  assert.equal(reservation?.cost_basis, "ESTIMATED", "with no reported cost, the reservation settles at its ceiling, labelled as an estimate");

  const metered = await sql<{ n: number }>`select count(*)::int as n from factory_costs where run_id = ${runId}`;
  assert.equal(metered[0]?.n, 0, "a provider that reports no cost writes no metered row");
});

test("a failed provider call releases its reservation and produces no creative", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-produce-failed");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" }, caps: { totalCents: 500 } });
  await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider({ outcome: "failed" });
  try {
    assert.equal(await produce(sql, tenant, runId), "variants:1;creatives:0");
  } finally {
    stub.restore();
  }
  assert.equal(stub.state.calls, 1);
  const [reservation] = await reservationsOf(sql, tenant);
  assert.equal(reservation?.status, "RELEASED", "a call that returned a failure releases what was reserved for it");
  const created = await sql<{ n: number }>`select count(*)::int as n from factory_creatives where run_id = ${runId}`;
  assert.equal(created[0]?.n, 0);
});

test("a named provider that is not ready stops the run with its reason, before any reservation or call", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-produce-not-ready");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" }, caps: { totalCents: 500 } });
  await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider({ configured: false });
  try {
    assert.equal(await produce(sql, tenant, runId), "stopped:factory.produce");
  } finally {
    stub.restore();
  }
  assert.equal(stub.state.calls, 0, "the provider was never called");
  const run = await runRow(sql, tenant, runId);
  assert.equal(run.status, "paused", "the run stops, and is not marked failed");
  assert.match(run.error, /google_nano_banana' is NOT_CONFIGURED/, "the run row names the provider and its state");
  assert.equal((await reservationsOf(sql, tenant)).length, 0, "no budget was reserved");
});

test("a provider that reports a cost writes one metered row, and the reservation settles at that cost", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-produce-cost");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" }, caps: { totalCents: 500 } });
  await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider({ costCents: 40 });
  try {
    assert.equal(await produce(sql, tenant, runId), "variants:1;creatives:1");
  } finally {
    stub.restore();
  }
  const costs = await sql<{ cents: number; provider: string; basis: string }>`
    select cents, provider, basis from factory_costs where run_id = ${runId}
  `;
  assert.equal(costs.length, 1, "one metered row, from the call that reported its cost");
  assert.equal(costs[0]?.cents, 40);
  assert.equal(costs[0]?.provider, "google_nano_banana");
  assert.equal(costs[0]?.basis, "provider_reported");
  const [reservation] = await reservationsOf(sql, tenant);
  assert.equal(reservation?.status, "RECONCILED");
  assert.equal(reservation?.cost_basis, "PROVIDER_ACTUAL", "the reservation settles at the reported cost, not at its ceiling");
});

test("a reached cap stops the run before the next provider call", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-produce-cap");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" }, caps: { totalCents: 40 } });
  await planRowsFor(sql, tenant, runId, ["image"], 2);
  const stub = stubImageProvider({ costCents: 40 });
  try {
    assert.equal(await produce(sql, tenant, runId), "stopped:factory.produce");
  } finally {
    stub.restore();
  }
  assert.equal(stub.state.calls, 1, "the first variant spent the cap; the second was refused before its call");
  const run = await runRow(sql, tenant, runId);
  assert.equal(run.status, "paused");
  assert.equal(run.error, "The spend cap for this run is reached.");
});

test("a call that does not return holds its reservation until the provider confirms no job exists, and the sweep then releases it", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-produce-unknown");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" }, caps: { totalCents: 500 } });
  await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider({ throws: true });
  try {
    assert.equal(await produce(sql, tenant, runId), "stopped:factory.produce");
  } finally {
    stub.restore();
  }
  const [held] = await reservationsOf(sql, tenant);
  assert.equal(held?.status, "RESERVED", "an outcome that is unknown keeps its reservation");

  // The screen's list shows the held amount to an admin. Nothing has been checked yet, because the window has not passed.
  await sql`update memberships set role = 'admin' where user_id = ${tenant.userId} and organization_id = ${tenant.organizationId}`;
  const listed = await listHeldReservations(sql, tenant.userId, tenant.brandId);
  const row = listed.find((item) => item.reservationId === held!.id);
  assert.ok(row, "the held reservation is listed");
  assert.equal(row?.amountUsd, 1, "the held amount is the reserved amount");
  assert.equal(row?.jobStatus, "SUBMISSION_UNKNOWN");
  assert.equal(row?.lastCheck, null, "a hold is not checked before its window has passed");

  // The window has passed, and no provider lookup exists for this provider, so the hold stays and the check records why.
  // (Owner decision, NORTH_STAR section 2, decision D: a hold is released only when the provider confirms no job exists.)
  await sql`update budget_reservations set expires_at = now() - interval '2 days' where id = ${held!.id}`;
  await releaseExpiredHolds(sql, { checkIntervalMinutes: 0 });
  assert.equal((await reservationsOf(sql, tenant))[0]?.status, "RESERVED", "with no lookup, the hold stays");
  const afterNoLookup = await listHeldReservations(sql, tenant.userId, tenant.brandId);
  assert.equal(afterNoLookup.find((item) => item.reservationId === held!.id)?.lastCheck?.result, "no_lookup", "the panel shows why it stays");

  // The provider's lookup confirms it holds no job for this submission. The hold is released once, with the reason and the actor.
  const confirmedAbsent = async () => ({ kind: "absent" as const });
  await releaseExpiredHolds(sql, { lookupFor: () => confirmedAbsent, checkIntervalMinutes: 0 });
  const [afterSweep] = await reservationsOf(sql, tenant);
  assert.equal(afterSweep?.status, "RELEASED", "a hold the provider confirms absent is released by the sweep");
  const releases = await sql<{ reason: string; actor: string }>`
    select metadata->>'reason' as reason, metadata->>'actor' as actor from budget_ledger_entries
    where reservation_id = ${held!.id} and entry_type = 'RESERVATION_RELEASED'
  `;
  assert.deepEqual(releases.map((item) => ({ reason: item.reason, actor: item.actor })), [{ reason: "window_expired", actor: "system" }]);
  await releaseExpiredHolds(sql, { lookupFor: () => confirmedAbsent, checkIntervalMinutes: 0 });
  const [afterSecondSweep] = await sql<{ n: number }>`
    select count(*)::int as n from budget_ledger_entries where reservation_id = ${held!.id} and entry_type = 'RESERVATION_RELEASED'
  `;
  assert.equal(afterSecondSweep?.n, 1, "a second sweep releases nothing more");
  const stillHeld = await listHeldReservations(sql, tenant.userId, tenant.brandId);
  assert.equal(stillHeld.some((item) => item.reservationId === held!.id), false, "a released reservation is no longer held");
});

test("the JEV creative check never passes a variant whose engine is not configured", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-gate-unconfigured");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" }, caps: { totalCents: 500 } });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider();
  try {
    await produce(sql, tenant, runId);
  } finally {
    stub.restore();
  }
  const [link] = await sql<{ creative_id: string }>`select creative_id from factory_creatives where run_id = ${runId}`;
  const [gate] = await sql<{ action: string }>`
    select action from decision_gate_records
    where organization_id = ${tenant.organizationId} and subject_type = 'creative' and subject_id = ${link!.creative_id} and gate = 'creative_qa'
    order by created_at desc limit 1
  `;
  assert.ok(gate, "the image's creative check is recorded");
  assert.notEqual(gate.action, "AUTO_APPROVE", "no configured engine means no approval");

  const verdict = await creativeQaVerdict(sql, tenant.organizationId, tenant.brandId, variantId!);
  assert.notEqual(verdict.result, "pass", "an unconfigured engine routes to review, never to pass");
  assert.equal(verdict.result, gate.action === "REJECT" ? "block" : "review");
});

test("the JEV creative check has no evidence for a variant with no creative, so it is review", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-gate-empty");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], caps: { totalCents: 500 } });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["image"]);
  const verdict = await creativeQaVerdict(sql, tenant.organizationId, tenant.brandId, variantId!);
  assert.equal(verdict.result, "review");
  assert.equal(verdict.gate, "jev");
});
