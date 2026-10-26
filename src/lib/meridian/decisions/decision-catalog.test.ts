// The OpenRouter decision catalogue, read from a recorded copy of the live endpoint (GET /api/v1/models?output_modalities=decisions,
// 2026-10-25). No test reaches the network: the source is given a fetch stub that returns the recorded body.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DECISION_CATALOG_CACHE_MS,
  DECISION_CATALOG_FAILURE_CACHE_MS,
  DEFAULT_DECISION_MAX_USD_PER_CALL,
  DecisionCatalogSource,
  decisionCallCapUsd,
  decisionCallCeilingUsd,
  decisionModelCeilingUsd,
  decisionModelProfile,
  eligibleDecisionModels,
  parseDecisionCatalog,
  parseUsdPerToken,
} from "./decision-catalog.ts";

const recorded: unknown = JSON.parse(readFileSync(new URL("./fixtures/openrouter-decisions-catalog-2026-10-25.json", import.meta.url), "utf8"));
const META = { endpoint: "https://openrouter.ai/api/v1/models?output_modalities=decisions", readAt: "2026-10-25T06:00:00.000Z" };

function recordedRead() {
  const read = parseDecisionCatalog(recorded, META);
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("the recorded catalogue must parse");
  return read;
}

test("the recorded live catalogue parses: 30 decision entries, the three aliases excluded with their reason", () => {
  const read = recordedRead();
  assert.equal(read.entries.length + read.excluded.length, 30, "every recorded row is either an entry or excluded with a reason");
  const aliases = read.excluded.filter((item) => item.id.startsWith("~"));
  assert.deepEqual(aliases.map((item) => item.id).sort(), ["~perplexity/pplx-decider-flash-latest", "~perplexity/pplx-decider-latest", "~typesafe/jev-latest"]);
  for (const alias of aliases) assert.match(alias.reason, /alias moves to new builds/);
});

test("an entry keeps the fields the decision needs: pinned id, canonical slug, input modalities, context and the input price", () => {
  const jev = recordedRead().entries.find((entry) => entry.id === "typesafe/jev-1.14");
  assert.ok(jev, "typesafe/jev-1.14 is in the recorded catalogue");
  assert.equal(jev.canonicalSlug, "typesafe/jev-1.14-20261014");
  assert.deepEqual(jev.inputModalities, ["text", "image"]);
  assert.equal(jev.contextLength, 262144);
  assert.equal(jev.promptUsdPerToken, 0.000000042);
});

test("only models with a verified profile are offered; the rest are listed with the reason they are not", () => {
  const { eligible, notOffered } = eligibleDecisionModels(recordedRead());
  assert.deepEqual(eligible.map((entry) => entry.id).sort(), ["typesafe/jev-1.13", "typesafe/jev-1.14"]);
  const unverified = notOffered.find((item) => item.id === "nace-ai/drex-max");
  assert.ok(unverified, "a catalogued decision model without a profile is listed");
  assert.match(unverified.reason, /has not verified which questions this model answers/);
});

test("a profile is a claim about the vendor's documentation, and jev-1.13 stays text-only although the catalogue lists image input", () => {
  const read = recordedRead();
  const catalogue = read.entries.find((entry) => entry.id === "typesafe/jev-1.13");
  assert.ok(catalogue?.inputModalities.includes("image"), "the recorded catalogue lists jev-1.13 with image input");
  assert.deepEqual(decisionModelProfile("typesafe/jev-1.13")?.inputModalities, ["text"], "the profile keeps the stricter reading until a source says otherwise");
  assert.deepEqual(decisionModelProfile("typesafe/jev-1.14")?.inputModalities, ["text", "image"]);
  assert.equal(decisionModelProfile("~typesafe/jev-latest"), null, "an alias never has a profile");
  assert.equal(decisionModelProfile("nace-ai/drex-max"), null, "a model with no profile has none, whatever its name");
});

test("the call ceiling is bounded by the request: its bytes at the input price, capped at the context, plus the largest output", () => {
  const jev = recordedRead().entries.find((entry) => entry.id === "typesafe/jev-1.14");
  assert.ok(jev);
  const wholeContext = 262144 * 0.000000042;
  // A short request is bounded by its bytes, which is far below the whole context.
  assert.ok(Math.abs(decisionCallCeilingUsd(jev, { requestBytes: 1000, hasImages: false }) - 1000 * 0.000000042) < 1e-12);
  // A request longer than the context is bounded by the context.
  assert.ok(Math.abs(decisionCallCeilingUsd(jev, { requestBytes: 10_000_000, hasImages: false }) - wholeContext) < 1e-12);
  // An image call is bounded by the whole context, because an image's tokens are not stated in the catalogue.
  assert.ok(Math.abs(decisionCallCeilingUsd(jev, { requestBytes: 1000, hasImages: true }) - wholeContext) < 1e-12);
  // The whole-model figure shown beside the model is the image bound.
  assert.ok(Math.abs(decisionModelCeilingUsd(jev) - wholeContext) < 1e-12);
});

test("the largest output adds to the bound at the output price, so a priced output is not left out", () => {
  const priced = { contextLength: 1000, promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002, maxCompletionTokens: 500 };
  assert.ok(Math.abs(decisionCallCeilingUsd(priced, { requestBytes: 100, hasImages: false }) - (100 * 0.000001 + 500 * 0.000002)) < 1e-12);
});

test("a model whose output is priced but whose largest output is not stated is excluded, since its cost cannot be bounded", () => {
  const body = {
    data: [
      { id: "fixture/priced-output", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] }, context_length: 1000, pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "fixture/free-output", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] }, context_length: 1000, pricing: { prompt: "0.000001", completion: "0" } },
    ],
  };
  const read = parseDecisionCatalog(body, { endpoint: "fixture", readAt: "2026-10-25T00:00:00Z" });
  assert.ok(read.ok);
  assert.deepEqual(read.entries.map((entry) => entry.id), ["fixture/free-output"]);
  assert.match(read.excluded.find((item) => item.id === "fixture/priced-output")?.reason ?? "", /largest output/);
});

test("a malformed body fails the whole read; a malformed or unpriced entry is excluded with its reason and the rest is kept", () => {
  assert.equal(parseDecisionCatalog({ nope: true }, META).ok, false);
  assert.equal(parseDecisionCatalog("not json body", META).ok, false);
  const body = {
    data: [
      { id: "vendor/no-price", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] }, context_length: 1000 },
      { id: "vendor/bad-price", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] }, context_length: 1000, pricing: { prompt: "abc" } },
      { id: "vendor/negative", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] }, context_length: 1000, pricing: { prompt: "-1" } },
      { id: "vendor/no-context", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] }, context_length: null, pricing: { prompt: "0.000001" } },
      { id: "vendor/chat-only", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, context_length: 1000, pricing: { prompt: "0.000001" } },
      { architecture: { output_modalities: ["decisions"] } },
      "not an object",
    ],
  };
  const read = parseDecisionCatalog(body, META);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.entries.length, 0);
  const reasons = Object.fromEntries(read.excluded.map((item) => [item.id, item.reason]));
  assert.match(reasons["vendor/no-price"] ?? "", /no usable input price/);
  assert.match(reasons["vendor/bad-price"] ?? "", /no usable input price/);
  assert.match(reasons["vendor/negative"] ?? "", /no usable input price/);
  assert.match(reasons["vendor/no-context"] ?? "", /no context length/);
  assert.match(reasons["vendor/chat-only"] ?? "", /Not a decision model/);
  assert.equal(read.excluded.length, 7, "every row is accounted for, including the ones that are not objects");
});

test("a price string is read as USD per token, and an absent, non-numeric or negative price is unknown, never zero", () => {
  assert.equal(parseUsdPerToken("0.000000042"), 0.000000042);
  assert.equal(parseUsdPerToken("0"), 0, "a stated zero price is zero");
  assert.equal(parseUsdPerToken(undefined), null);
  assert.equal(parseUsdPerToken(""), null);
  assert.equal(parseUsdPerToken("n/a"), null);
  assert.equal(parseUsdPerToken("-0.1"), null);
});

test("the per-call limit defaults to the documented value, reads the deployment variable, and refuses a value that is not a positive number", () => {
  const saved = process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL;
  try {
    delete process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL;
    assert.deepEqual(decisionCallCapUsd(), { ok: true, usd: DEFAULT_DECISION_MAX_USD_PER_CALL });
    process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL = "0.01";
    assert.deepEqual(decisionCallCapUsd(), { ok: true, usd: 0.01 });
    for (const bad of ["0", "-1", "abc", "Infinity"]) {
      process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL = bad;
      assert.equal(decisionCallCapUsd().ok, false, `${bad} is refused, so a mistyped limit never allows more than it says`);
    }
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL;
    else process.env.OPENROUTER_DECISION_MAX_USD_PER_CALL = saved;
  }
});

function countingFetch(body: unknown, status = 200) {
  const calls = { count: 0 };
  const fetchImpl = (async () => {
    calls.count += 1;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("the catalogue source reads the live endpoint without a key, caches a good read, and never caches a failed one for long", async () => {
  let now = Date.parse("2026-10-25T06:00:00.000Z");
  const good = countingFetch(recorded);
  const source = new DecisionCatalogSource({ fetchImpl: good.fetchImpl, now: () => now });
  assert.equal((await source.read()).ok, true);
  assert.equal((await source.read()).ok, true);
  assert.equal(good.calls.count, 1, "a good read is reused within its lifetime");
  now += DECISION_CATALOG_CACHE_MS + 1;
  await source.read();
  assert.equal(good.calls.count, 2, "a good read expires");

  let failNow = Date.parse("2026-10-25T06:00:00.000Z");
  const bad = countingFetch({ error: "down" }, 503);
  const failing = new DecisionCatalogSource({ fetchImpl: bad.fetchImpl, now: () => failNow });
  const first = await failing.read();
  assert.equal(first.ok, false);
  if (!first.ok) assert.match(first.reason, /returned 503, so no decision model could be checked/);
  await failing.read();
  assert.equal(bad.calls.count, 1, "a failed read is remembered briefly, so each decision does not wait for the network again");
  failNow += DECISION_CATALOG_FAILURE_CACHE_MS + 1;
  await failing.read();
  assert.equal(bad.calls.count, 2, "after the short memory, the catalogue is asked again");
});

test("a catalogue that cannot be reached is reported as unavailable, with no model offered", async () => {
  const source = new DecisionCatalogSource({
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    now: () => Date.parse("2026-10-25T06:00:00.000Z"),
  });
  const read = await source.read();
  assert.equal(read.ok, false);
  if (!read.ok) assert.match(read.reason, /could not be reached, so no decision model could be checked/);
});
