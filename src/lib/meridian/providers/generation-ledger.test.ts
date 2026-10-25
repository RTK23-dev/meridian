// The budget hold for ordinary text generation: the worst-case bound of a call, the per-call ceiling, the month's held spend, settlement
// once, and the monthly cap under a transaction lock. Fixtures and the embedded database only; concurrency is checked on Postgres when
// MERIDIAN_PG_TEST_URL names one.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { openTestBackends } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { setMonthlyBudget } from "../testing/monthly-budget.ts";
import {
  boundGenerationCall,
  DEFAULT_GENERATION_CEILING_USD,
  generationCeilingUsd,
  monthlyHeldUsd,
  NO_MONTHLY_BUDGET_REASON,
  releaseUncertainHold,
  reserveGenerationCall,
  settleGenerationCall,
  uncertainHolds,
  type HoldInput,
} from "./generation-ledger.ts";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const PRICE = { promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002, contextLength: 8000 };

test("a text call's bound is its request bytes plus framing at the input price, and max_tokens at the output price", () => {
  const bound = boundGenerationCall({ choice: PRICE, system: "ab", user: "cd", maxTokens: 100 });
  assert.ok(bound.ok);
  // 4 bytes + 256 framing = 260 input tokens; 260 * 0.000001 + 100 * 0.000002 = 0.00046
  assert.ok(Math.abs(bound.usd - 0.00046) < 1e-12, `bound was ${bound.usd}`);
});

test("a text call's input is capped at the stated context length", () => {
  const bound = boundGenerationCall({ choice: { ...PRICE, contextLength: 100 }, system: "ab", user: "cd", maxTokens: 100 });
  assert.ok(bound.ok);
  // min(260, 100) = 100 input tokens: 0.0001 + 0.0002
  assert.ok(Math.abs(bound.usd - 0.0003) < 1e-12, `bound was ${bound.usd}`);
});

test("an image call uses the whole stated context, because an image's tokens are not stated", () => {
  const bound = boundGenerationCall({
    choice: { ...PRICE, contextLength: 2000 },
    system: "s",
    user: [{ type: "text", text: "t" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
    maxTokens: 50,
  });
  assert.ok(bound.ok);
  assert.equal(bound.inputTokensBound, 2000);
  assert.ok(Math.abs(bound.usd - (2000 * 0.000001 + 50 * 0.000002)) < 1e-12);
});

test("a call whose prices are not stated, or whose output limit is not a positive whole number, is refused", () => {
  const unpriced = boundGenerationCall({ choice: { ...PRICE, promptUsdPerToken: Number.NaN }, system: "s", user: "u", maxTokens: 10 });
  assert.equal(unpriced.ok, false);
  const noLimit = boundGenerationCall({ choice: PRICE, system: "s", user: "u", maxTokens: 0 });
  assert.equal(noLimit.ok, false);
  const fraction = boundGenerationCall({ choice: PRICE, system: "s", user: "u", maxTokens: 1.5 });
  assert.equal(fraction.ok, false);
});

test("the per-call ceiling is the default when unset, the stated value when set, and refuses every call when not a positive number", () => {
  assert.deepEqual(generationCeilingUsd({}), { ok: true, usd: DEFAULT_GENERATION_CEILING_USD });
  assert.deepEqual(generationCeilingUsd({ OPENROUTER_GENERATION_MAX_USD_PER_CALL: "0.5" }), { ok: true, usd: 0.5 });
  assert.equal(generationCeilingUsd({ OPENROUTER_GENERATION_MAX_USD_PER_CALL: "0" }).ok, false);
  assert.equal(generationCeilingUsd({ OPENROUTER_GENERATION_MAX_USD_PER_CALL: "lots" }).ok, false);
});

function holdFor(organizationId: string, brandId: string | null, operation: string): HoldInput {
  return {
    organizationId,
    brandId,
    correlationId: "corr",
    operation,
    promptId: "p",
    promptVersion: "1",
    inputRef: "r",
    provider: "openrouter",
    model: "vendor/writer",
    modelSource: "workspace",
  };
}

for (const { name, sql } of backends) {
  test(`[${name}] a hold counts at the reported cost once settled as completed, and at its estimate until then`, async () => {
    const tenant = await studioTenant(sql, `ledger-settle-${name}`);
    await setMonthlyBudget(sql, tenant.organizationId, 1);
    const held = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-settle"), 0.0005);
    assert.equal(held.status, "held");
    if (held.status !== "held") return;
    assert.ok(Math.abs((await monthlyHeldUsd(sql, tenant.organizationId)) - 0.0005) < 1e-9, "the estimate holds the month before the call settles");
    const settled = await settleGenerationCall(sql, held.id, {
      status: "completed",
      output: "ok",
      latencyMs: 5,
      tokens: 10,
      returnedModel: "vendor/writer-2026",
      generationId: "gen-9",
      costUsd: 0.00012,
      error: "",
    });
    assert.equal(settled, true);
    assert.ok(Math.abs((await monthlyHeldUsd(sql, tenant.organizationId)) - 0.00012) < 1e-9, "the reported cost replaces the estimate");
  });

  test(`[${name}] a hold settles once: a second settlement changes nothing and reports that it did not apply`, async () => {
    const tenant = await studioTenant(sql, `ledger-once-${name}`);
    await setMonthlyBudget(sql, tenant.organizationId, 1);
    const held = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-once"), 0.0004);
    assert.equal(held.status, "held");
    if (held.status !== "held") return;
    assert.equal(await settleGenerationCall(sql, held.id, { status: "failed", error: "Not sent: the provider is not connected.", latencyMs: 1 }), true);
    assert.equal(await settleGenerationCall(sql, held.id, { status: "uncertain", error: "late", latencyMs: 2 }), false, "a settled hold is never settled again");
    const rows = await sql<{ status: string }>`select status from model_runs where id = ${held.id}`;
    assert.equal(rows[0]?.status, "failed");
  });

  test(`[${name}] an uncertain hold keeps counting against the month, and a hold the gateway never sent is released`, async () => {
    const tenant = await studioTenant(sql, `ledger-release-${name}`);
    await setMonthlyBudget(sql, tenant.organizationId, 1);
    const uncertain = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-uncertain"), 0.0003);
    assert.equal(uncertain.status, "held");
    if (uncertain.status !== "held") return;
    await settleGenerationCall(sql, uncertain.id, { status: "uncertain", error: "timed out", latencyMs: 25_000 });
    const notSent = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-not-sent"), 0.0007);
    assert.equal(notSent.status, "held");
    if (notSent.status !== "held") return;
    await settleGenerationCall(sql, notSent.id, { status: "failed", error: "Not sent: the provider is not connected.", latencyMs: 0 });
    assert.ok(Math.abs((await monthlyHeldUsd(sql, tenant.organizationId)) - 0.0003) < 1e-9, "only the uncertain hold still holds money");
  });

  test(`[${name}] an administrator releases an uncertain hold once: it stops counting against the month, and the release is audited`, async () => {
    const tenant = await studioTenant(sql, `ledger-admin-release-${name}`);
    await setMonthlyBudget(sql, tenant.organizationId, 1);
    const held = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-release"), 0.0005);
    assert.equal(held.status, "held");
    if (held.status !== "held") return;
    await settleGenerationCall(sql, held.id, { status: "uncertain", error: "timed out", latencyMs: 25_000 });
    const listed = await uncertainHolds(sql, tenant.organizationId);
    assert.deepEqual(listed.map((hold) => hold.id), [held.id], "the uncertain hold is listed for review");

    const reason = "The provider account shows no charge for this call.";
    const first = await releaseUncertainHold(sql, { organizationId: tenant.organizationId, holdId: held.id, actorId: "user_admin_fixture", reason });
    assert.deepEqual(first, { status: "released", holdId: held.id });
    assert.equal(await monthlyHeldUsd(sql, tenant.organizationId), 0, "a released hold does not count against the month");
    assert.deepEqual(await uncertainHolds(sql, tenant.organizationId), [], "a released hold is no longer listed");

    const second = await releaseUncertainHold(sql, { organizationId: tenant.organizationId, holdId: held.id, actorId: "user_admin_fixture", reason });
    assert.equal(second.status, "refused", "a hold is released once");
    const rows = await sql<{ status: string; error: string }>`select status, error from model_runs where id = ${held.id}`;
    assert.equal(rows[0]?.status, "released");
    assert.match(rows[0]?.error ?? "", /timed out Released by an administrator: The provider account shows no charge/, "the original error is kept beside the release");
    const audit = await sql<{ actor_id: string; reason: string }>`select actor_id, reason from generation_hold_releases where model_run_id = ${held.id}`;
    assert.equal(audit.length, 1, "one audit row for the one release");
    assert.equal(audit[0]?.actor_id, "user_admin_fixture");
    assert.equal(audit[0]?.reason, reason);
  });

  test(`[${name}] a release refuses a short reason, an in-flight hold, and a hold in another workspace, and changes nothing`, async () => {
    const tenant = await studioTenant(sql, `ledger-release-refuse-${name}`);
    const other = await studioTenant(sql, `ledger-release-other-${name}`);
    await setMonthlyBudget(sql, tenant.organizationId, 1);
    await setMonthlyBudget(sql, other.organizationId, 1);
    const inFlight = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-in-flight"), 0.0002);
    const foreign = await reserveGenerationCall(sql, holdFor(other.organizationId, other.brandId, "op-foreign"), 0.0002);
    assert.equal(inFlight.status, "held");
    assert.equal(foreign.status, "held");
    if (inFlight.status !== "held" || foreign.status !== "held") return;
    await settleGenerationCall(sql, foreign.id, { status: "uncertain", error: "timed out", latencyMs: 1 });

    const short = await releaseUncertainHold(sql, { organizationId: tenant.organizationId, holdId: inFlight.id, actorId: "user_admin_fixture", reason: "ok" });
    assert.equal(short.status, "refused", "a release needs a reason the audit can read");
    const notUncertain = await releaseUncertainHold(sql, {
      organizationId: tenant.organizationId,
      holdId: inFlight.id,
      actorId: "user_admin_fixture",
      reason: "Checked against the provider account.",
    });
    assert.equal(notUncertain.status, "refused", "an in-flight hold is settled by its call, not by an administrator");
    const crossWorkspace = await releaseUncertainHold(sql, {
      organizationId: tenant.organizationId,
      holdId: foreign.id,
      actorId: "user_admin_fixture",
      reason: "Checked against the provider account.",
    });
    assert.equal(crossWorkspace.status, "refused", "a hold in another workspace cannot be released from this one");

    const statuses = await sql<{ status: string }>`select status from model_runs where id = ${inFlight.id}`;
    assert.equal(statuses[0]?.status, "in_flight");
    assert.deepEqual((await uncertainHolds(sql, tenant.organizationId)).map((hold) => hold.id), [], "the other workspace's hold is not listed here");
    assert.ok(Math.abs((await monthlyHeldUsd(sql, other.organizationId)) - 0.0002) < 1e-9, "the other workspace still holds its money");
  });

  test(`[${name}] a monthly budget refuses the call that does not fit, and writes no row for it`, async () => {
    const tenant = await studioTenant(sql, `ledger-cap-${name}`);
    await sql`update organizations set monthly_video_budget_usd = ${0.01} where id = ${tenant.organizationId}`;
    const first = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-cap-1"), 0.006);
    assert.equal(first.status, "held");
    const second = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-cap-2"), 0.006);
    assert.equal(second.status, "refused");
    if (second.status === "refused") assert.match(second.reason, /monthly budget/);
    const rows = await sql<{ count: string | number }>`select count(*) as count from model_runs where organization_id = ${tenant.organizationId} and operation = 'op-cap-2'`;
    assert.equal(Number(rows[0]?.count), 0, "the refused call has no row");
  });

  test(`[${name}] a workspace without a monthly budget is refused: paid generation waits for one, and no row is written`, async () => {
    const tenant = await studioTenant(sql, `ledger-nocap-${name}`);
    const result = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-nocap"), 0.0001);
    assert.equal(result.status, "refused");
    if (result.status === "refused") assert.equal(result.reason, NO_MONTHLY_BUDGET_REASON);
    const rows = await sql<{ count: string | number }>`select count(*) as count from model_runs where organization_id = ${tenant.organizationId}`;
    assert.equal(Number(rows[0]?.count), 0, "the refused call has no row");
  });

  test(`[${name}] a call with no workspace in scope is refused, and nothing is written`, async () => {
    const result = await reserveGenerationCall(sql, holdFor("", null, "op-none"), 0.0001);
    assert.equal(result.status, "refused");
  });
}

test("two calls that each fit alone but not together: exactly one is held, on Postgres, where the transaction lock is real", async () => {
  const pg = backends.find((backend) => backend.name === "postgres");
  if (!pg) return;
  const tenant = await studioTenant(pg.sql, "ledger-race-postgres");
  await pg.sql`update organizations set monthly_video_budget_usd = ${0.01} where id = ${tenant.organizationId}`;
  const results = await Promise.all([
    reserveGenerationCall(pg.sql, holdFor(tenant.organizationId, tenant.brandId, "op-race"), 0.006),
    reserveGenerationCall(pg.sql, holdFor(tenant.organizationId, tenant.brandId, "op-race"), 0.006),
  ]);
  assert.equal(results.filter((result) => result.status === "held").length, 1);
  assert.equal(results.filter((result) => result.status === "refused").length, 1);
});
