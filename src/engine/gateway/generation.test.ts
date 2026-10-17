// The OpenRouter generation bill (contract v9, gateway/generation.ts) on recorded answers: a billed generation, and every kind of miss that
// must stay unavailable. The answers are synthetic, in the documented shape, and UNVERIFIED LIVE. No test calls a live API.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { openRouterGenerationBill } from "./generation.ts";
import { createGateway } from "./gateway.ts";
import { json, recorded, staticKeys } from "./test/recorded.ts";
import type { HttpResponse } from "./types.ts";
import { routes } from "../config/routes.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures");
const billed = JSON.parse(readFileSync(join(FIXTURES, "openrouter-generation.json"), "utf8")) as unknown;
const noCost = JSON.parse(readFileSync(join(FIXTURES, "openrouter-generation-no-cost.json"), "utf8")) as unknown;
const GENERATION = "gen-1760695200-speech0001";

function gatewayWith(responses: HttpResponse[], keys: Record<string, string> = { openrouter: "sk-or-test" }) {
  const script = recorded(responses);
  const gateway = createGateway({ transport: script.transport, credentials: staticKeys(keys), routes: routes.table });
  return { gateway, requests: script.requests };
}

describe("the bill of one OpenRouter generation (contract v9)", () => {
  it("reads total_cost once, in USD, from the generation stats, with the workspace's key", async () => {
    const { gateway, requests } = gatewayWith([json(200, billed)]);
    const bill = await openRouterGenerationBill(gateway, { organizationId: "org_1", generationId: GENERATION });
    assert.deepEqual(bill, { status: "billed", usd: 0.0031 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "GET");
    assert.equal(requests[0]?.url, `https://openrouter.ai/api/v1/generation?id=${GENERATION}`);
    assert.equal(requests[0]?.headers.Authorization, "Bearer sk-or-test");
    assert.equal(requests[0]?.body, undefined, "a read sends no body");
  });

  it("a stats answer with no total_cost is unavailable, never a bill of zero", async () => {
    const { gateway } = gatewayWith([json(200, noCost)]);
    const bill = await openRouterGenerationBill(gateway, { organizationId: "org_1", generationId: GENERATION });
    assert.equal(bill.status, "unavailable");
    if (bill.status === "unavailable") assert.match(bill.reason, /no total_cost/);
  });

  it("a stats answer that is not yet there (HTTP 404, stats can lag) is unavailable, with its status", async () => {
    const { gateway } = gatewayWith([json(404, { error: "not found" })]);
    const bill = await openRouterGenerationBill(gateway, { organizationId: "org_1", generationId: GENERATION });
    assert.equal(bill.status, "unavailable");
    if (bill.status === "unavailable") assert.match(bill.reason, /HTTP 404/);
  });

  it("a negative or non-finite total_cost is unavailable", async () => {
    for (const body of [{ data: { total_cost: -0.01 } }, { data: { total_cost: null } }]) {
      const { gateway } = gatewayWith([json(200, body)]);
      const bill = await openRouterGenerationBill(gateway, { organizationId: "org_1", generationId: GENERATION });
      assert.equal(bill.status, "unavailable", JSON.stringify(body));
    }
  });

  it("an answer that is not JSON is unavailable", async () => {
    const { gateway } = gatewayWith([{ status: 200, headers: {}, body: new TextEncoder().encode("<html>") }]);
    const bill = await openRouterGenerationBill(gateway, { organizationId: "org_1", generationId: GENERATION });
    assert.equal(bill.status, "unavailable");
    if (bill.status === "unavailable") assert.match(bill.reason, /not JSON/);
  });

  it("no key for the workspace is not connected: unavailable, and nothing is sent", async () => {
    const { gateway, requests } = gatewayWith([json(200, billed)], {});
    const bill = await openRouterGenerationBill(gateway, { organizationId: "org_1", generationId: GENERATION });
    assert.equal(bill.status, "unavailable");
    if (bill.status === "unavailable") assert.match(bill.reason, /not connected/);
    assert.equal(requests.length, 0);
  });

  it("a transport that throws is unavailable with the reason, not an error", async () => {
    const gateway = createGateway({
      transport: async () => {
        throw new Error("socket hang up");
      },
      credentials: staticKeys({ openrouter: "sk-or-test" }),
      routes: routes.table,
    });
    const bill = await openRouterGenerationBill(gateway, { organizationId: "org_1", generationId: GENERATION });
    assert.equal(bill.status, "unavailable");
    if (bill.status === "unavailable") assert.match(bill.reason, /socket hang up/);
  });

  it("a generation id the engine would not look up is unavailable, and nothing is sent", async () => {
    const { gateway, requests } = gatewayWith([json(200, billed)]);
    for (const generationId of ["", "gen 1", "gen-1&x=2", "g".repeat(257)]) {
      const bill = await openRouterGenerationBill(gateway, { organizationId: "org_1", generationId });
      assert.equal(bill.status, "unavailable", generationId);
    }
    assert.equal(requests.length, 0);
  });
});
