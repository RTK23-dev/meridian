// The budget hold for each OpenRouter Decisions call, on fixtures. A fetch stub stands in for the provider, so no test reaches the
// network. The in-memory ledger checks each outcome settles its hold once, at the right status, before the next step runs. The
// database cases check the same rules on the real model_runs table, on the embedded backend and on Postgres when
// MERIDIAN_PG_TEST_URL names one: the hold is written before the send, the monthly budget refuses a call that does not fit, and an
// uncertain call keeps counting against the month.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { openTestBackends, withEnv } from "../../../test-support/lib/meridian/credentials/test-databases.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import { setMonthlyBudget } from "../../../test-support/lib/meridian/testing/monthly-budget.ts";
import { recordedDecisionCatalogSource } from "./recorded-decision-catalog.ts";
import { monthlyHeldUsd, reserveGenerationCall, type HoldInput } from "../providers/generation-ledger.ts";
import type { JevQuestionSpec } from "../jev/types.ts";
import { ledgerHoldsOn, memoryDecisionHolds, type DecisionHolds } from "./holds.ts";
import { OpenRouterDecisionsEngine, type OpenRouterCheckStore, type OpenRouterKeySource, OPENROUTER_DECISIONS_EXAMPLE_MODEL } from "./openrouter-engine.ts";
import type { DecisionRequest } from "./types.ts";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const ORG = "org_hold_fixture";
const BRAND = "brand_hold_fixture";
const KEY = "sk-or-v1-hold-fixture-secret-0123456789abcdef";
const FINGERPRINT = "sk-or-…cdef";
const MODEL = "typesafe/jev-1.14";
const REPORTED_COST = 0.0000149;
const ANSWERED_BODY = {
  model: "typesafe/jev-1.14-20261014",
  provider: "TypeSafe",
  id: "gen-dec-hold-1",
  answers: { refund: { type: "noul", noul: 0.93 } },
  usage: { input_tokens: 357, output_tokens: 38, cost: REPORTED_COST },
};

const NOUL: JevQuestionSpec = {
  id: "fixture.hold.refund.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Does the ticket ask for a refund?",
  criteria: { true: "The customer asks for money back.", false: "The customer asks for anything else." },
  evidenceRequirements: [],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 } as const,
} as unknown as JevQuestionSpec;

type Call = { url: string; body: Record<string, unknown> };

/** A fetch stub. Each call is recorded, and the handler decides the response, or throws to stand in for a network failure. */
function fakeFetch(handler: (index: number) => Response | Promise<Response> | Error): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const outcome = await handler(calls.length - 1);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function keysFor(organizationId: string): OpenRouterKeySource {
  return {
    async keyFor(requested) {
      if (requested !== organizationId) return { secret: null, fingerprint: "", reason: "No key is saved for this workspace." };
      return { secret: KEY, fingerprint: FINGERPRINT, reason: "" };
    },
  };
}

const noCheck: OpenRouterCheckStore = {
  async workspaceModel() {
    return OPENROUTER_DECISIONS_EXAMPLE_MODEL;
  },
  async latestCheck() {
    return null;
  },
};

function request(organizationId: string, brandId: string): DecisionRequest {
  return {
    organizationId,
    brandId,
    state: { description: "Ticket: I was charged twice this month and want the second charge back." },
    questions: { refund: NOUL },
  } as DecisionRequest;
}

function engineWith(organizationId: string, holds: DecisionHolds, fetchImpl: typeof fetch): OpenRouterDecisionsEngine {
  return new OpenRouterDecisionsEngine({
    holds,
    fetchImpl,
    keys: keysFor(organizationId),
    store: noCheck,
    deploymentModel: undefined,
    catalog: recordedDecisionCatalogSource(),
  });
}

/** The in-memory ledger, with every reserve and settle written to one ordered trace shared with the fetch stub. */
function tracedHolds(events: string[]): ReturnType<typeof memoryDecisionHolds> {
  const holds = memoryDecisionHolds();
  const reserve = holds.reserve;
  const settle = holds.settle;
  holds.reserve = (input, estimateUsd) => {
    events.push("reserve");
    return reserve(input, estimateUsd);
  };
  holds.settle = (holdId, settlement) => {
    events.push(`settle:${settlement.status}`);
    return settle(holdId, settlement);
  };
  return holds;
}

test("a decision is held before it is sent, and settles once as completed at the provider's reported cost", async () => {
  const events: string[] = [];
  const holds = tracedHolds(events);
  const { fetch, calls } = fakeFetch(() => {
    events.push("sent");
    return json(ANSWERED_BODY);
  });
  const result = await engineWith(ORG, holds, fetch).decide(request(ORG, BRAND));

  assert.deepEqual(events, ["reserve", "sent", "settle:completed"]);
  assert.equal(calls.length, 1);
  assert.equal(holds.reserved.length, 1);
  const reserved: HoldInput = holds.reserved[0]!;
  assert.equal(reserved.organizationId, ORG);
  assert.equal(reserved.brandId, BRAND);
  assert.equal(reserved.operation, "jev.decision");
  assert.equal(reserved.provider, "openrouter");
  assert.equal(reserved.model, MODEL, "the hold names the model the call was sent to, not the one the provider later returned");
  assert.equal(reserved.modelSource, "workspace");
  assert.equal(holds.settled.length, 1);
  const settlement = holds.settled[0]!.settlement;
  assert.equal(settlement.status, "completed");
  assert.equal(settlement.status === "completed" ? settlement.costUsd : null, REPORTED_COST, "the reported cost is what the hold settles at");
  assert.equal(settlement.status === "completed" ? settlement.generationId : null, "gen-dec-hold-1");
  assert.equal(settlement.status === "completed" ? settlement.returnedModel : null, "typesafe/jev-1.14-20261014");
  assert.equal(result.failure, undefined);
  assert.equal(result.usage?.reportedCostUsd, REPORTED_COST);
});

test("an answer that the provider billed but that is not usable still settles as completed, because the call was made", async () => {
  const holds = memoryDecisionHolds();
  const { fetch } = fakeFetch(() => json({ ...ANSWERED_BODY, answers: { refund: { type: "noul", noul: 7 } } }));
  const result = await engineWith(ORG, holds, fetch).decide(request(ORG, BRAND));

  assert.equal(result.answers.refund!.status, "invalid_response");
  assert.equal(holds.settled.length, 1);
  assert.equal(holds.settled[0]!.settlement.status, "completed", "a billed call is never released as if nothing was sent");
});

test("a request the ledger refuses is never sent, and the answer carries the ledger's reason", async () => {
  const holds: DecisionHolds = {
    async reserve() {
      return { status: "refused", reason: "This call could cost up to $0.000400, and the month's held spend is $0.010000 of a $0.01 monthly budget. Nothing was sent." };
    },
    async settle() {
      throw new Error("a refused call has no hold to settle");
    },
  };
  const { fetch, calls } = fakeFetch(() => json(ANSWERED_BODY));
  const result = await engineWith(ORG, holds, fetch).decide(request(ORG, BRAND));

  assert.equal(calls.length, 0);
  assert.equal(result.failure?.kind, "budget_refused");
  assert.match(result.failure?.message ?? "", /monthly budget/);
  assert.equal(result.answers.refund!.status, "unsupported");
});

test("a call above the per-call limit is refused before any hold is written, so nothing is held and nothing is sent", async () => {
  const holds = memoryDecisionHolds();
  const { fetch, calls } = fakeFetch(() => json(ANSWERED_BODY));
  const result = await withEnv({ OPENROUTER_DECISION_MAX_USD_PER_CALL: "0.0000001" }, () =>
    engineWith(ORG, holds, fetch).decide(request(ORG, BRAND)),
  );

  assert.equal(calls.length, 0);
  assert.equal(result.failure?.kind, "budget_refused");
  assert.equal(holds.reserved.length, 0, "no hold is written for a call that is refused before it is priced against the ledger");
  assert.equal(holds.settled.length, 0);
});

// No documented error status is a billing rule, so every error status keeps its hold until an administrator releases it.
const ERROR_STATUSES = [400, 401, 402, 403, 404, 408, 413, 422, 429, 500, 502, 503, 524, 529];
for (const status of ERROR_STATUSES) {
  test(`an HTTP ${status} may have been billed: its hold stays uncertain until an administrator releases it, and the call is not retried`, async () => {
    const holds = memoryDecisionHolds();
    const { fetch, calls } = fakeFetch(() => json({ error: "the provider refused or failed the request" }, status));
    const result = await engineWith(ORG, holds, fetch).decide(request(ORG, BRAND));

    assert.equal(calls.length, 1, "an error response is not sent again");
    assert.equal(holds.settled.length, 1);
    const settlement = holds.settled[0]!.settlement;
    assert.equal(settlement.status, "uncertain");
    assert.match(settlement.error, /Whether it was billed is not known, so the hold stays on the ledger until an administrator releases it/);
    assert.equal(result.answers.refund!.status, "provider_error");
  });
}

test("a timeout is uncertain: its hold stays and the call is not retried", async () => {
  const holds = memoryDecisionHolds();
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const { fetch, calls } = fakeFetch(() => timeout);
  const result = await engineWith(ORG, holds, fetch).decide(request(ORG, BRAND));

  assert.equal(calls.length, 1);
  assert.equal(result.failure?.kind, "timeout");
  assert.equal(holds.settled[0]!.settlement.status, "uncertain");
});

test("a network failure after the request was sent is uncertain: its hold stays and the call is not retried", async () => {
  const holds = memoryDecisionHolds();
  const { fetch, calls } = fakeFetch(() => new TypeError("fetch failed"));
  const result = await engineWith(ORG, holds, fetch).decide(request(ORG, BRAND));

  assert.equal(calls.length, 1);
  assert.equal(result.failure?.kind, "network");
  assert.equal(holds.settled[0]!.settlement.status, "uncertain");
});

test("a 200 whose body is not JSON is uncertain: the provider may have billed it", async () => {
  const holds = memoryDecisionHolds();
  const { fetch, calls } = fakeFetch(() => json("<html>gateway</html>", 200));
  const result = await engineWith(ORG, holds, fetch).decide(request(ORG, BRAND));

  assert.equal(calls.length, 1);
  assert.equal(result.failure?.kind, "invalid_response");
  assert.equal(holds.settled[0]!.settlement.status, "uncertain");
});

test("a 200 with no answers object is uncertain: the provider may have billed it", async () => {
  const holds = memoryDecisionHolds();
  const { fetch } = fakeFetch(() => json({ id: "gen-dec-hold-2", model: MODEL }));
  const result = await engineWith(ORG, holds, fetch).decide(request(ORG, BRAND));

  assert.equal(result.failure?.kind, "invalid_response");
  assert.equal(holds.settled[0]!.settlement.status, "uncertain");
});

test("the order is reserve, send, settle; no step runs twice and nothing is settled before the send", async () => {
  const events: string[] = [];
  const holds = tracedHolds(events);
  const { fetch } = fakeFetch(() => {
    events.push("sent");
    return json({ error: "rejected" }, 400);
  });
  await engineWith(ORG, holds, fetch).decide(request(ORG, BRAND));

  assert.deepEqual(events, ["reserve", "sent", "settle:uncertain"]);
});

test("a ledger that cannot be written refuses the call without sending it", async () => {
  const holds = ledgerHoldsOn(async () => {
    throw new Error("connection refused");
  });
  const { fetch, calls } = fakeFetch(() => json(ANSWERED_BODY));
  const result = await engineWith(ORG, holds, fetch).decide(request(ORG, BRAND));

  assert.equal(calls.length, 0, "no hold, no call");
  assert.equal(result.failure?.kind, "budget_refused");
  assert.match(result.failure?.message ?? "", /could not be written, so nothing was sent/);
});

/** A workspace with a monthly budget, which paid generation needs (providers/generation-ledger.ts). The budget is large enough that no test here reaches it. */
async function budgetedTenant(sql: Parameters<typeof studioTenant>[0], label: string) {
  const tenant = await studioTenant(sql, label);
  await setMonthlyBudget(sql, tenant.organizationId, 1);
  return tenant;
}

for (const { name, sql } of backends) {
  const ledger = ledgerHoldsOn(async () => sql);

  test(`[${name}] the decision's hold is in flight while the call is sent, and completes at the reported cost`, async () => {
    const tenant = await budgetedTenant(sql, `decision-hold-complete-${name}`);
    let inFlightDuringSend: Array<{ status: string }> = [];
    const { fetch } = fakeFetch(async () => {
      inFlightDuringSend = await sql<{ status: string }>`
        select status from model_runs where organization_id = ${tenant.organizationId} and operation = 'jev.decision'
      `;
      return json(ANSWERED_BODY);
    });
    const result = await engineWith(tenant.organizationId, ledger, fetch).decide(request(tenant.organizationId, tenant.brandId));

    assert.deepEqual(inFlightDuringSend.map((row) => row.status), ["in_flight"], "the hold is written before the call is sent");
    assert.equal(result.failure, undefined);
    const rows = await sql<{
      status: string;
      provider: string;
      model: string;
      model_source: string;
      returned_model: string;
      generation_id: string;
      cost_usd: string | number | null;
      estimate_usd: string | number | null;
      brand_id: string | null;
    }>`
      select status, provider, model, model_source, returned_model, generation_id, cost_usd, estimate_usd, brand_id
      from model_runs where organization_id = ${tenant.organizationId} and operation = 'jev.decision'
    `;
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.status, "completed");
    assert.equal(row.provider, "openrouter");
    assert.equal(row.model, MODEL);
    assert.equal(row.model_source, "workspace");
    assert.equal(row.returned_model, "typesafe/jev-1.14-20261014");
    assert.equal(row.generation_id, "gen-dec-hold-1");
    assert.equal(row.brand_id, tenant.brandId);
    assert.ok(Math.abs(Number(row.cost_usd) - REPORTED_COST) < 1e-9, "the reported cost is recorded as the cost");
    assert.ok(Number(row.estimate_usd) > 0, "the estimate is kept beside the reported cost");
    assert.ok(Math.abs((await monthlyHeldUsd(sql, tenant.organizationId)) - REPORTED_COST) < 1e-9, "the month holds the reported cost");
  });

  test(`[${name}] an error status keeps its hold on the month, and the call is not sent again`, async () => {
    const tenant = await budgetedTenant(sql, `decision-hold-error-${name}`);
    const { fetch, calls } = fakeFetch(() => json({ error: "bad request" }, 400));
    await engineWith(tenant.organizationId, ledger, fetch).decide(request(tenant.organizationId, tenant.brandId));

    assert.equal(calls.length, 1);
    const rows = await sql<{ status: string; cost_usd: string | number | null; estimate_usd: string | number }>`
      select status, cost_usd, estimate_usd from model_runs where organization_id = ${tenant.organizationId} and operation = 'jev.decision'
    `;
    assert.equal(rows[0]?.status, "uncertain");
    assert.equal(rows[0]?.cost_usd, null, "no cost is recorded: the provider reported none");
    const estimate = Number(rows[0]?.estimate_usd);
    assert.ok(estimate > 0);
    assert.ok(Math.abs((await monthlyHeldUsd(sql, tenant.organizationId)) - estimate) < 1e-9, "the hold counts at its estimate until released");
  });

  test(`[${name}] an uncertain decision keeps its hold, so a later decision the month cannot fit is refused without a send`, async () => {
    const tenant = await budgetedTenant(sql, `decision-hold-uncertain-${name}`);
    await sql`update organizations set monthly_video_budget_usd = ${0.01} where id = ${tenant.organizationId}`;
    const first = fakeFetch(() => json({ error: "the provider failed" }, 500));
    await engineWith(tenant.organizationId, ledger, first.fetch).decide(request(tenant.organizationId, tenant.brandId));
    assert.equal(first.calls.length, 1, "an uncertain call is not retried");

    const [row] = await sql<{ status: string; estimate_usd: string | number }>`
      select status, estimate_usd from model_runs where organization_id = ${tenant.organizationId} and operation = 'jev.decision'
    `;
    assert.equal(row?.status, "uncertain");
    const estimate = Number(row?.estimate_usd);
    assert.ok(estimate > 0 && estimate < 0.01, "the estimate is positive and fits the test budget on its own");
    assert.ok(Math.abs((await monthlyHeldUsd(sql, tenant.organizationId)) - estimate) < 1e-9, "the uncertain hold counts at its estimate");

    const filler = await reserveGenerationCall(
      sql,
      {
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        correlationId: "filler",
        operation: "filler",
        promptId: "filler",
        promptVersion: "1",
        inputRef: "filler",
        provider: "openrouter",
        model: MODEL,
        modelSource: "workspace",
      },
      0.01 - estimate,
    );
    assert.equal(filler.status, "held", "the rest of the month is filled by another hold");

    const second = fakeFetch(() => json(ANSWERED_BODY));
    const result = await engineWith(tenant.organizationId, ledger, second.fetch).decide(request(tenant.organizationId, tenant.brandId));
    assert.equal(second.calls.length, 0, "the month has no room, so nothing is sent");
    assert.equal(result.failure?.kind, "budget_refused");
    assert.match(result.failure?.message ?? "", /monthly budget/);
    const count = await sql<{ count: string | number }>`
      select count(*) as count from model_runs where organization_id = ${tenant.organizationId} and operation = 'jev.decision'
    `;
    assert.equal(Number(count[0]?.count), 1, "the refused decision has no row");
  });

  test(`[${name}] a monthly budget already held in full refuses a decision before anything is sent`, async () => {
    const tenant = await budgetedTenant(sql, `decision-hold-full-${name}`);
    await sql`update organizations set monthly_video_budget_usd = ${0.01} where id = ${tenant.organizationId}`;
    const filler = await reserveGenerationCall(
      sql,
      {
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        correlationId: "filler",
        operation: "filler",
        promptId: "filler",
        promptVersion: "1",
        inputRef: "filler",
        provider: "openrouter",
        model: MODEL,
        modelSource: "workspace",
      },
      0.01,
    );
    assert.equal(filler.status, "held");

    const { fetch, calls } = fakeFetch(() => json(ANSWERED_BODY));
    const result = await engineWith(tenant.organizationId, ledger, fetch).decide(request(tenant.organizationId, tenant.brandId));
    assert.equal(calls.length, 0);
    assert.equal(result.failure?.kind, "budget_refused");
    assert.match(result.failure?.message ?? "", /monthly budget/);
    const count = await sql<{ count: string | number }>`
      select count(*) as count from model_runs where organization_id = ${tenant.organizationId} and operation = 'jev.decision'
    `;
    assert.equal(Number(count[0]?.count), 0, "the refused decision writes no row");
  });
}
