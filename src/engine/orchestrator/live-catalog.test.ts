import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { gatewayFor, json } from "../claude/test/helpers.ts";
import { mergeListings, ORCHESTRATOR_LISTINGS, readOrchestratorCatalog, rowOf } from "./live-catalog.ts";

const NOW = "2026-10-21T10:00:00.000Z";
const listings = JSON.parse(readFileSync(new URL("./fixtures/openrouter-listings-trimmed-2026-10-20.json", import.meta.url), "utf8")).listings as Record<string, unknown>;
const replies = () => ORCHESTRATOR_LISTINGS.map((listing) => json(200, listings[listing.path]));

describe("the orchestrator's live catalog (the four public listings, read through the gateway)", () => {
  test("the four listings become one catalog, each row with the price its kind is priced from", async () => {
    const { gateway, requests } = gatewayFor(replies());
    const read = await readOrchestratorCatalog(gateway, { organizationId: "org_1", now: () => NOW });
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    const haiku = read.catalog.byId.get("anthropic/claude-haiku-5.5");
    assert.equal(haiku?.kind, "text");
    assert.equal(haiku?.pricing.promptUsdPerToken, 1e-7);
    assert.equal(haiku?.pricing.completionUsdPerToken, 5e-7);
    assert.equal(read.catalog.byId.get("bytedance-seed/seedream-5-0-pro")?.pricing.imageUsd, 0.003);
    assert.equal(read.catalog.byId.get("alibaba/wan-3.0")?.pricing.usdPerSecond1080p, 0.2);
    assert.equal(read.catalog.byId.get("elevenlabs/eleven-multilingual-v2")?.kind, "speech");
    assert.equal(read.catalog.takenAt, NOW);
    assert.deepEqual(requests.map((request) => request.url.replace("https://openrouter.ai/api/v1", "")), ORCHESTRATOR_LISTINGS.map((listing) => listing.path));
  });

  test("a row with no id is dropped with its reason, and the rows around it are kept", async () => {
    const { gateway } = gatewayFor(replies());
    const read = await readOrchestratorCatalog(gateway, { organizationId: "org_1", now: () => NOW });
    if (read.status !== "ok") throw new Error("the fixture catalog must read");
    assert.equal(read.catalog.dropped.length, 1);
    assert.ok(read.catalog.byId.has("anthropic/claude-opus-5.5"));
  });

  test("a model in two listings keeps its most specific kind", () => {
    const text = { data: [{ id: "vendor/both", name: "Both", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000002" } }] };
    const image = { data: [{ id: "vendor/both", name: "Both", architecture: { input_modalities: ["text"], output_modalities: ["image"] }, pricing: { image: "0.01" } }] };
    const catalog = mergeListings([{ kind: "text", body: text }, { kind: "image", body: image }], NOW);
    assert.equal(catalog.byId.get("vendor/both")?.kind, "image");
    assert.equal(catalog.byId.get("vendor/both")?.pricing.imageUsd, 0.01);
  });

  test("a price the listing does not state is null, never zero", () => {
    const row = rowOf({ id: "vendor/no-price", pricing: {} }, "text");
    assert.deepEqual((row.pricing as Record<string, unknown>).promptUsdPerToken, null);
    assert.deepEqual((row.pricing as Record<string, unknown>).completionUsdPerToken, null);
  });

  test("no connected key: not_connected with the reason, and no listing is read", async () => {
    const { gateway, requests } = gatewayFor([], { keys: {} });
    const read = await readOrchestratorCatalog(gateway, { organizationId: "org_1", now: () => NOW });
    assert.equal(read.status, "not_connected");
    assert.equal(requests.length, 0);
  });

  test("a listing that fails: failed with the reason, and no partial catalog is returned", async () => {
    const { gateway } = gatewayFor([json(500, { error: "unavailable" })]);
    const read = await readOrchestratorCatalog(gateway, { organizationId: "org_1", now: () => NOW });
    assert.equal(read.status, "failed");
    if (read.status === "failed") assert.match(read.reason, /GET \/models failed/);
    assert.equal("catalog" in read, false);
  });
});
