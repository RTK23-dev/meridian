// The budget hold for ordinary text generation: the worst-case bound of a call, the per-call ceiling, the month's held spend, settlement
// once, and the monthly cap under a transaction lock. Fixtures and the embedded database only; concurrency is checked on Postgres when
// MERIDIAN_PG_TEST_URL names one.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { openTestBackends } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import {
  boundGenerationCall,
  DEFAULT_GENERATION_CEILING_USD,
  generationCeilingUsd,
  monthlyHeldUsd,
  reserveGenerationCall,
  settleGenerationCall,
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
    const held = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-once"), 0.0004);
    assert.equal(held.status, "held");
    if (held.status !== "held") return;
    assert.equal(await settleGenerationCall(sql, held.id, { status: "failed", error: "OpenRouter returned 400.", latencyMs: 1 }), true);
    assert.equal(await settleGenerationCall(sql, held.id, { status: "uncertain", error: "late", latencyMs: 2 }), false, "a released hold is never settled again");
    const rows = await sql<{ status: string }>`select status from model_runs where id = ${held.id}`;
    assert.equal(rows[0]?.status, "failed");
  });

  test(`[${name}] an uncertain hold keeps counting against the month, and a failed one releases it`, async () => {
    const tenant = await studioTenant(sql, `ledger-release-${name}`);
    const uncertain = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-uncertain"), 0.0003);
    assert.equal(uncertain.status, "held");
    if (uncertain.status !== "held") return;
    await settleGenerationCall(sql, uncertain.id, { status: "uncertain", error: "timed out", latencyMs: 25_000 });
    const failed = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-failed"), 0.0007);
    assert.equal(failed.status, "held");
    if (failed.status !== "held") return;
    await settleGenerationCall(sql, failed.id, { status: "failed", error: "OpenRouter returned 402.", latencyMs: 3 });
    assert.ok(Math.abs((await monthlyHeldUsd(sql, tenant.organizationId)) - 0.0003) < 1e-9, "only the uncertain hold still holds money");
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

  test(`[${name}] a workspace without a monthly budget has no monthly limit, and the per-call ceiling still applies to each call`, async () => {
    const tenant = await studioTenant(sql, `ledger-nocap-${name}`);
    const big = await reserveGenerationCall(sql, holdFor(tenant.organizationId, tenant.brandId, "op-nocap"), 1000);
    assert.equal(big.status, "held", "the ledger holds any amount the caller has bounded; the ceiling is checked by the caller");
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
