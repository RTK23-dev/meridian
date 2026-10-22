import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { BUDGET_RESERVATION_SCHEMA, budgetReservationSchema } from "../contracts/index.ts";
import { newId } from "../contracts/ids.ts";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import type { ResolvedRoute } from "../gateway/gateway.ts";
import type { PlanNode } from "./contracts.ts";
import { NotConnectedError, type NodeHandler } from "./execute.ts";
import { analysisAnswerSchema, productionHandlers, scriptAnswerSchema, type ProductionDeps } from "./production.ts";

const ORG = "org_production_a";
const CREATED = "2026-10-22T10:00:00.000Z";
const RES = newId("res_");
const REQ = newId("req_");

/** A reservation of the given amount on the memory ledger, shaped as the run's reservation is (run-budget.ts). */
async function ledgerWith(reservedUsd: number): Promise<LedgerStore> {
  const ledger = memoryLedgerStore();
  await ledger.createReservation(
    budgetReservationSchema.parse({
      schema: BUDGET_RESERVATION_SCHEMA,
      reservationId: RES,
      requestId: REQ,
      workspaceId: ORG,
      mode: "cap",
      lines: [{ stage: "orchestrator_run", estimateUsd: reservedUsd }],
      estimateUsd: reservedUsd,
      redoAllowanceUsd: 0,
      reservedUsd,
      requestBudgetUsd: 5,
      workspaceMonthBudgetUsd: 100,
      state: "reserved",
      createdAt: CREATED,
    }),
  );
  return ledger;
}

function depsWith(ledger: LedgerStore, extra: Partial<ProductionDeps> = {}): ProductionDeps {
  return {
    organizationId: ORG,
    planId: "plan_1",
    reservationId: RES,
    ledger,
    now: () => CREATED,
    connection: async () => ({ connected: true, reason: null }),
    textRoute: (modelId) => ({ capability: "llm.analysis", provider: { id: "openrouter" } as ResolvedRoute["provider"], model: modelId, priceKey: null, verified: false }),
    structured: async () => {
      throw new Error("no answer recorded for this test");
    },
    brand: async () => null,
    ...extra,
  };
}

function node(over: Partial<PlanNode> & Pick<PlanNode, "id" | "kind">): PlanNode {
  return {
    title: "a step",
    why: "because the plan needs it",
    dependsOn: [],
    model: { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" },
    params: {},
    estimateUsd: 0.01,
    ...over,
  };
}

const NO_UPSTREAM = new Map<string, string | null>();

describe("production handlers: reference (no model call)", () => {
  test("a reference with text stores the text as its body and spends nothing", async () => {
    const ledger = await ledgerWith(1);
    const handler = productionHandlers(depsWith(ledger)).reference as NodeHandler;
    const out = await handler({ node: node({ id: "ref", kind: "reference", model: null, estimateUsd: null, params: { text: "Launch day copy" } }), key: "k", upstream: NO_UPSTREAM });
    assert.equal(out.body, "Launch day copy");
    assert.equal(out.costUsd, null);
    assert.equal((await ledger.listEntries(RES)).length, 0, "no call, so no ledger entry");
  });

  test("a reference to a brand stores the brand's facts, and a brand outside the organization is refused", async () => {
    const facts = { name: "Acme", description: "tools", category: "", industry: "", website: "", countryMarket: "", sells: "" };
    const found = productionHandlers(depsWith(await ledgerWith(1), { brand: async () => facts }))
      .reference as NodeHandler;
    const out = await found({ node: node({ id: "ref", kind: "reference", model: null, estimateUsd: null, params: { brandId: "brand_a" } }), key: "k", upstream: NO_UPSTREAM });
    assert.deepEqual(JSON.parse(out.body ?? "null"), facts);

    const missing = productionHandlers(depsWith(await ledgerWith(1))).reference as NodeHandler;
    await assert.rejects(
      missing({ node: node({ id: "ref", kind: "reference", model: null, estimateUsd: null, params: { brandId: "brand_b" } }), key: "k", upstream: NO_UPSTREAM }),
      /not in this organization/,
    );
  });

  test("a reference with neither a brand nor text fails and reads nothing", async () => {
    const handler = productionHandlers(depsWith(await ledgerWith(1))).reference as NodeHandler;
    await assert.rejects(handler({ node: node({ id: "ref", kind: "reference", model: null, estimateUsd: null }), key: "k", upstream: NO_UPSTREAM }), /nothing to read/);
  });
});

describe("production handlers: analysis and script (paid text calls)", () => {
  test("a step whose provider is not connected stops before any call, and holds nothing", async () => {
    const ledger = await ledgerWith(1);
    let called = false;
    const deps = depsWith(ledger, {
      connection: async () => ({ connected: false, reason: "no key" }),
      structured: async () => {
        called = true;
        throw new Error("must not be called");
      },
    });
    const handler = productionHandlers(deps).script as NodeHandler;
    await assert.rejects(handler({ node: node({ id: "s", kind: "script" }), key: "k", upstream: new Map([["ref", "brief text"]]) }), NotConnectedError);
    assert.equal(called, false);
    assert.equal((await ledger.listEntries(RES)).length, 0);
  });

  test("a script call is authorized, billed at the reported cost, and its lines are stored as the body", async () => {
    const ledger = await ledgerWith(1);
    const seen: string[] = [];
    const deps = depsWith(ledger, {
      structured: async (_route, call) => {
        seen.push(...call.messages.map((message) => String(message.content)));
        return { value: call.schema.parse({ lines: ["Hook line", "Second line"] }), actualUsd: 0.0012 };
      },
    });
    const handler = productionHandlers(deps).script as NodeHandler;
    const out = await handler({ node: node({ id: "s", kind: "script", dependsOn: ["ref"] }), key: "k1", upstream: new Map([["ref", "brief text"]]) });
    assert.equal(out.body, "Hook line\nSecond line");
    assert.equal(out.costUsd, 0.0012);
    const entries = await ledger.listEntries(RES);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.actualUsd, 0.0012, "the bill is recorded on the ledger");
    assert.ok(seen.some((text) => text.includes("brief text")), "the upstream body reaches the model as data");
  });

  test("the same step is never paid twice: a second attempt with the same key is refused, and nothing is called", async () => {
    const ledger = await ledgerWith(1);
    let calls = 0;
    const deps = depsWith(ledger, {
      structured: async (_route, call) => {
        calls += 1;
        return { value: call.schema.parse({ summary: "ok", points: [] }), actualUsd: 0.001 };
      },
    });
    const handler = productionHandlers(deps).analysis as NodeHandler;
    const input = { node: node({ id: "a", kind: "analysis", dependsOn: ["ref"] }), key: "same", upstream: new Map([["ref", "x"]]) };
    await handler(input);
    await assert.rejects(handler(input), /already made/);
    assert.equal(calls, 1);
  });

  test("a call the budget refuses is not made", async () => {
    const ledger = await ledgerWith(0.001);
    let called = false;
    const deps = depsWith(ledger, {
      structured: async () => {
        called = true;
        throw new Error("must not be called");
      },
    });
    const handler = productionHandlers(deps).analysis as NodeHandler;
    await assert.rejects(handler({ node: node({ id: "a", kind: "analysis", dependsOn: ["ref"], estimateUsd: 0.01 }), key: "k", upstream: new Map([["ref", "x"]]) }), /budget refused/);
    assert.equal(called, false);
  });

  test("an answer that does not match its schema fails the step, and its hold stays on the ledger", async () => {
    const ledger = await ledgerWith(1);
    const deps = depsWith(ledger, {
      structured: async (_route, call) => ({ value: call.schema.parse({ wrong: true }), actualUsd: 0.001 }),
    });
    const handler = productionHandlers(deps).analysis as NodeHandler;
    await assert.rejects(handler({ node: node({ id: "a", kind: "analysis", dependsOn: ["ref"] }), key: "k", upstream: new Map([["ref", "x"]]) }));
    const entries = await ledger.listEntries(RES);
    assert.equal(entries.length, 1, "the call was authorized, so its hold is kept");
  });

  test("a step that reads an upstream step with no stored body fails closed, and calls nothing", async () => {
    const ledger = await ledgerWith(1);
    const handler = productionHandlers(depsWith(ledger)).script as NodeHandler;
    await assert.rejects(handler({ node: node({ id: "s", kind: "script", dependsOn: ["ref"] }), key: "k", upstream: new Map([["ref", null]]) }), /no stored content/);
    assert.equal((await ledger.listEntries(RES)).length, 0);
  });

  test("the answer schemas bound what a body can hold", () => {
    assert.throws(() => scriptAnswerSchema.parse({ lines: [] }));
    assert.throws(() => analysisAnswerSchema.parse({ summary: "", points: [] }));
    assert.ok(z.object({ lines: scriptAnswerSchema.shape.lines }).safeParse({ lines: ["a"] }).success);
  });

  test("the kinds with no production handler are not connected: they have no entry, so the executor reports them not_connected", () => {
    const handlers = productionHandlers(depsWith(memoryLedgerStore()));
    for (const kind of ["visual", "voice", "video", "avatar", "edit", "compose", "render"] as const) {
      assert.equal(handlers[kind], undefined, `${kind} has no production handler yet`);
    }
  });
});
