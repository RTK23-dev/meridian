// Gemini Decisions on fixtures shaped like Google's documented generateContent response. No test calls Google.

import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_KEYS, contractRequest } from "../../../test-support/lib/meridian/decisions/contract-fixtures.ts";
import { GeminiDecisionsEngine, safeGeminiText } from "./gemini-engine.ts";
import { memoryDecisionHolds } from "./holds.ts";

const KEY = "AIzaSyFixtureFixtureFixtureFixture12345";
const ORG = "org_gemini_fixture";

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function reply(answers: unknown[], extra: Record<string, unknown> = {}): Response {
  const text = JSON.stringify({ answers });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }, modelVersion: "gemini-fixture-001", responseId: "resp_1", ...extra }), { status: 200 });
}

/** Answers every question by name, in the shape the engine asks for. */
function echoFetch(calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body, headers: init?.headers as Record<string, string> });
    const prompt = (body.contents as Array<{ parts: Array<{ text: string }> }>)[0].parts[0].text;
    const questions = JSON.parse(prompt.slice(prompt.indexOf("Questions (JSON):\n") + "Questions (JSON):\n".length)) as Array<Record<string, unknown>>;
    return reply(questions.map((q) => {
      if (q.type === "predicate") return { name: q.name, type: "predicate", probability: 0.9 };
      if (q.type === "choice") return { name: q.name, type: "choice", choice: (q.choices as Array<{ value: string }>)[0].value, confidence: 0.8 };
      return { name: q.name, type: "score", score: 1, confidence: 0.7 };
    }));
  }) as typeof fetch;
}

const noSleep = async () => undefined;
function engineWith(fetchImpl: typeof fetch, over: { cap?: number | null; holds?: ReturnType<typeof memoryDecisionHolds>; model?: string | null; key?: string | null } = {}) {
  const holds = over.holds ?? memoryDecisionHolds();
  const engine = new GeminiDecisionsEngine({
    fetchImpl,
    holds,
    maxUsdPerCall: async () => (over.cap === undefined ? 0.05 : over.cap),
    key: async () => (over.key === null ? { secret: null, reason: "No Gemini key is saved for this workspace." } : { secret: over.key ?? KEY, reason: "" }),
    model: async () => (over.model === undefined ? "gemini-fixture-pro" : over.model),
    sleep: noSleep,
  });
  return { engine, holds };
}
const request = () => ({ ...contractRequest(), organizationId: ORG });

test("an answered decision: every kind is read, the model is in the address, the key is in a header and never the body, and the call is held then settled", async () => {
  const calls: Call[] = [];
  const { engine, holds } = engineWith(echoFetch(calls));
  const result = await engine.decide(request());
  assert.equal(result.engineId, "gemini-decisions");
  assert.equal(result.answers[CONTRACT_KEYS.predicate].status, "answered");
  assert.equal(result.answers[CONTRACT_KEYS.predicate].probability, 0.9);
  assert.equal(result.answers[CONTRACT_KEYS.choice].status, "answered");
  assert.equal(result.answers[CONTRACT_KEYS.score].status, "answered");
  assert.equal(result.answers[CONTRACT_KEYS.predicate].provider, "gemini");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/models\/gemini-fixture-pro:generateContent$/);
  assert.equal(calls[0].headers["x-goog-api-key"], KEY);
  assert.ok(!JSON.stringify(calls[0].body).includes(KEY) && !calls[0].url.includes(KEY), "the key is not in the body or the address");
  assert.equal(holds.reserved.length, 1, "one hold before the call");
  assert.equal(holds.settled.length, 1);
  assert.equal(holds.settled[0].settlement.status, "completed");
  assert.equal(result.usage?.totalTokens, 120);
});

test("an unset decision cap sends nothing: no request and no hold", async () => {
  const calls: Call[] = [];
  const { engine, holds } = engineWith(echoFetch(calls), { cap: null });
  const result = await engine.decide(request());
  assert.equal(calls.length, 0);
  assert.equal(holds.reserved.length, 0);
  assert.equal(result.failure?.kind, "budget_refused");
  assert.ok(Object.values(result.answers).every((answer) => answer.status !== "answered"));
});

test("no key or no chosen model is not configured, and nothing is sent", async () => {
  const calls: Call[] = [];
  const noKey = await engineWith(echoFetch(calls), { key: null }).engine.decide(request());
  const noModel = await engineWith(echoFetch(calls), { model: null }).engine.decide(request());
  assert.equal(calls.length, 0);
  assert.equal(noKey.failure?.kind, "not_configured");
  assert.equal(noModel.failure?.kind, "not_configured");
  assert.match(noModel.failure?.message ?? "", /model/i);
});

test("readiness needs both a key and a chosen model, and makes no request", async () => {
  const calls: Call[] = [];
  assert.equal((await engineWith(echoFetch(calls)).engine.healthFor(ORG)).status, "READY");
  assert.equal((await engineWith(echoFetch(calls), { key: null }).engine.healthFor(ORG)).status, "NOT_CONFIGURED");
  assert.equal((await engineWith(echoFetch(calls), { model: null }).engine.healthFor(ORG)).status, "NOT_CONFIGURED");
  assert.equal(calls.length, 0);
});

test("a missing, mistyped or out-of-range answer is an invalid response, never a verdict, and the call is still settled", async () => {
  const fetchImpl = (async () => reply([
    { name: "q1", type: "predicate", probability: 1.7 },
    { name: "q2", type: "choice", choice: "not_a_defined_value" },
  ])) as typeof fetch;
  const { engine, holds } = engineWith(fetchImpl);
  const result = await engine.decide(request());
  assert.equal(result.answers[CONTRACT_KEYS.predicate].status, "invalid_response");
  assert.equal(result.answers[CONTRACT_KEYS.choice].status, "invalid_response");
  assert.equal(result.answers[CONTRACT_KEYS.score].status, "invalid_response", "an unanswered question is not answered");
  assert.equal(holds.settled[0].settlement.status, "completed", "a billed call is counted whether or not its answers are usable");
});

test("a bad key (HTTP 403) was not billed, so its hold is released as failed, and the key never appears in the reason", async () => {
  const fetchImpl = (async () => new Response(`API key not valid: ${KEY}`, { status: 403 })) as typeof fetch;
  const { engine, holds } = engineWith(fetchImpl);
  const result = await engine.decide(request());
  assert.equal(result.failure?.kind, "authentication");
  assert.equal(holds.settled[0].settlement.status, "failed");
  assert.ok(!JSON.stringify(result).includes(KEY), "the key is redacted");
});

test("a timeout may have been billed: it is not retried and its hold stays uncertain", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; const e = new Error("timed out"); e.name = "TimeoutError"; throw e; }) as typeof fetch;
  const { engine, holds } = engineWith(fetchImpl);
  const result = await engine.decide(request());
  assert.equal(calls, 1);
  assert.equal(result.failure?.kind, "timeout");
  assert.equal(holds.settled[0].settlement.status, "uncertain");
});

test("a server error is retried once, then its hold is uncertain", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return new Response("busy", { status: 503 }); }) as typeof fetch;
  const { engine, holds } = engineWith(fetchImpl);
  const result = await engine.decide(request());
  assert.equal(calls, 2);
  assert.equal(result.failure?.kind, "provider_unavailable");
  assert.equal(holds.settled[0].settlement.status, "uncertain");
});

test("a hold the ledger refuses stops the call before anything is sent", async () => {
  const calls: Call[] = [];
  const holds = { ...memoryDecisionHolds(), async reserve() { return { status: "refused" as const, reason: "The monthly budget is reached. Nothing was sent." }; } };
  const result = await engineWith(echoFetch(calls), { holds: holds as never }).engine.decide(request());
  assert.equal(calls.length, 0);
  assert.equal(result.failure?.kind, "budget_refused");
});

test("a request with no workspace is refused", async () => {
  const calls: Call[] = [];
  const { organizationId: _drop, ...noOrg } = request();
  const result = await engineWith(echoFetch(calls)).engine.decide(noOrg as never);
  assert.equal(calls.length, 0);
  assert.equal(result.failure?.kind, "not_configured");
});

test("provider text has Google keys removed and is short", () => {
  const text = safeGeminiText(`bad ${KEY}\n\n${"x".repeat(500)}`);
  assert.ok(!text.includes(KEY));
  assert.ok(text.length <= 300);
});
