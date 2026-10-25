// The OpenRouter Decisions adapter on fixtures: a fetch stub stands in for the Decisions API, so no test reaches the network. The
// tests cover the request the adapter builds, the answers it maps back, every way a call can fail, the images it refuses or omits,
// the key and model it resolves for one workspace, and the readiness it reports. Nothing here reads a key from the environment.

import assert from "node:assert/strict";
import test from "node:test";
import type { JevQuestionSpec } from "../jev/types.ts";
import { contractPngBytes } from "./contract-fixtures.ts";
import type { DecisionCatalogSource } from "./decision-catalog.ts";
import { recordedDecisionCatalogSource } from "../testing/decision-catalog-fixture.ts";
import {
  OPENROUTER_DECISIONS_DEFAULT_MODEL,
  OpenRouterDecisionsEngine,
  capabilitiesOfModel,
  failureKindForStatus,
  normalizeOpenRouterAnswer,
  resolveOpenRouterDecisionModel,
  safeProviderText,
  toOpenRouterQuestion,
  validateDecisionModel,
  type OpenRouterCheckStore,
  type OpenRouterKeySource,
} from "./openrouter-engine.ts";
import type { OpenRouterCheckRecord } from "./openrouter-settings.ts";
import type { DecisionRequest } from "./types.ts";

const KEY = "sk-or-v1-fixture-secret-0123456789abcdef";
const KEY_FINGERPRINT = "sk-or-…cdef";
const ORG = "org_openrouter_fixture";
const OTHER_ORG = "org_openrouter_other";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

const NOUL: JevQuestionSpec = {
  id: "fixture.noul.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Does the ticket ask for a refund?",
  criteria: { true: "The customer asks for money back.", false: "The customer asks for anything else." },
  evidenceRequirements: [],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 } as const,
} as unknown as JevQuestionSpec;

const CHOICE: JevQuestionSpec = {
  id: "fixture.choice.v1",
  version: "1.0.0",
  type: "choice",
  instructions: "Which team should handle this ticket?",
  criteria: { billing: "Charges, invoices and refunds", support: "Setup and usage help" },
  evidenceRequirements: [],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 } as const,
} as unknown as JevQuestionSpec;

const SCORE: JevQuestionSpec = {
  id: "fixture.score.v1",
  version: "1.0.0",
  type: "score",
  instructions: "How severe is the defect?",
  criteria: ["Cosmetic: no impact on function", "Minor: a workaround exists", "Severe: the feature is unusable"],
  evidenceRequirements: [],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 } as const,
} as unknown as JevQuestionSpec;

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    organizationId: ORG,
    brandId: "brand_fixture",
    state: { description: "Ticket: I was charged twice this month and want the second charge back." },
    questions: { refund: NOUL },
    ...overrides,
  } as DecisionRequest;
}

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A fetch stub. Each call is recorded with its parsed body, and the handler decides the response. */
function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response> | Error): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    const outcome = await handler(call, calls.length - 1);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const keySource: OpenRouterKeySource = {
  async keyFor(organizationId) {
    if (organizationId !== ORG) return { secret: null, fingerprint: "", reason: "No key is saved for this workspace." };
    return { secret: KEY, fingerprint: KEY_FINGERPRINT, reason: "" };
  },
};

const noCheck: OpenRouterCheckStore = {
  async workspaceModel() {
    return null;
  },
  async latestCheck() {
    return null;
  },
};

function engine(options: { fetchImpl?: typeof fetch; store?: OpenRouterCheckStore; keys?: OpenRouterKeySource; deploymentModel?: string; catalog?: DecisionCatalogSource } = {}): OpenRouterDecisionsEngine {
  return new OpenRouterDecisionsEngine({ keys: keySource, store: noCheck, deploymentModel: undefined, catalog: recordedDecisionCatalogSource(), ...options });
}

/** A Decisions response body for the given answers. */
function decisionBody(answers: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "typesafe/jev-1.14-20261014",
    provider: "TypeSafe",
    id: "gen-dec-fixture-1",
    answers,
    usage: { input_tokens: 357, output_tokens: 38, cost: 0.0000149 },
    ...extra,
  };
}

test("a noul question is sent to the Decisions endpoint with the model, state and question, and the key is only in the header", async () => {
  const { fetch, calls } = fakeFetch(() => json(decisionBody({ refund: { type: "noul", noul: 0.93 } })));
  const result = await engine({ fetchImpl: fetch }).decide(request());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, ENDPOINT);
  assert.equal(calls[0]!.init.method, "POST");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(calls[0]!.body.model, OPENROUTER_DECISIONS_DEFAULT_MODEL);
  assert.equal(typeof calls[0]!.body.state, "string", "a text-only request sends its state as a string");
  assert.deepEqual(calls[0]!.body.questions, { refund: { type: "noul", instructions: NOUL.instructions + "\nTrue when: The customer asks for money back.\nFalse when: The customer asks for anything else." } }, "noul carries its criteria in the instructions and no criteria field");
  assert.equal(result.failure, undefined);
  assert.equal(result.answers.refund!.status, "answered");
});

test("a choice question sends its option map as criteria, and maps the chosen value and probabilities back", async () => {
  const { fetch, calls } = fakeFetch(() =>
    json(decisionBody({ team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, support: 0.1 }, confidence: 0.9 } })),
  );
  const result = await engine({ fetchImpl: fetch }).decide(request({ questions: { team: CHOICE } }));
  assert.deepEqual(calls[0]!.body.questions, { team: { type: "choice", instructions: CHOICE.instructions, criteria: { billing: "Charges, invoices and refunds", support: "Setup and usage help" } } });
  const answer = result.answers.team!;
  assert.equal(answer.status, "answered");
  assert.equal((answer as { choice: string }).choice, "billing");
  assert.deepEqual((answer as { probabilities: Record<string, number> }).probabilities, { billing: 0.9, support: 0.1 });
  assert.equal((answer as { calibrationStatus: string }).calibrationStatus, "uncalibrated", "a provider probability is never a calibrated Meridian probability");
});

test("a score question sends its ordered levels, and its legend follows the levels in order", async () => {
  const { fetch, calls } = fakeFetch(() =>
    json(decisionBody({ severity: { type: "score", score: 1.2, probabilities: { "0": 0, "1": 0.8, "2": 0.2 }, confidence: 0.8 } })),
  );
  const result = await engine({ fetchImpl: fetch }).decide(request({ questions: { severity: SCORE } }));
  assert.deepEqual(calls[0]!.body.questions, { severity: { type: "score", instructions: SCORE.instructions, criteria: ["no impact on function", "a workaround exists", "the feature is unusable"] } });
  const answer = result.answers.severity! as { score: number; legend: Record<string, string>; probabilities: Record<string, number> };
  assert.equal(answer.score, 1.2);
  assert.deepEqual(answer.legend, { "0": "Cosmetic", "1": "Minor", "2": "Severe" });
  assert.deepEqual(answer.probabilities, { Cosmetic: 0, Minor: 0.8, Severe: 0.2 }, "probabilities are keyed by the level label, not array order");
});

test("several questions go in one request, and each answer is read by its own name, not by position", async () => {
  const { fetch, calls } = fakeFetch(() =>
    json(decisionBody({
      severity: { type: "score", score: 0, probabilities: { "0": 1 } },
      refund: { type: "noul", noul: 0.1 },
    })),
  );
  const result = await engine({ fetchImpl: fetch }).decide(request({ questions: { refund: NOUL, severity: SCORE } }));
  assert.equal(calls.length, 1, "one decision is one call");
  assert.deepEqual(Object.keys(calls[0]!.body.questions as object).sort(), ["refund", "severity"]);
  assert.equal(result.answers.refund!.status, "answered");
  assert.equal(result.answers.severity!.status, "answered");
  assert.equal((result.answers.refund as { noul: number }).noul, 0.1);
});

test("the result keeps the requested model, the model and provider the provider reported, its usage and its reported cost", async () => {
  const { fetch } = fakeFetch(() => json(decisionBody({ refund: { type: "noul", noul: 0.5 } })));
  const result = await engine({ fetchImpl: fetch }).decide(request());
  assert.equal(result.engineId, "openrouter-decisions");
  assert.equal(result.requestedModel, OPENROUTER_DECISIONS_DEFAULT_MODEL);
  assert.equal(result.returnedModel, "typesafe/jev-1.14-20261014");
  assert.equal(result.upstreamProvider, "TypeSafe");
  assert.equal(result.providerRequestId, "gen-dec-fixture-1");
  assert.equal(result.usage?.inputTokens, 357);
  assert.equal(result.usage?.reportedCostUsd, 0.0000149);
  const ceiling = result.usage?.ceilingUsd ?? 0;
  assert.ok(ceiling > 0 && ceiling < 262144 * 0.000000042, "the request's bound is kept beside the reported cost, and it is below the whole context");
  assert.equal(result.inputModality, "text");
  assert.equal(result.imageCount, 0);
  assert.equal(result.imagesOmitted, 0);
});

test("no question means no call, and an empty answer set is returned", async () => {
  const { fetch, calls } = fakeFetch(() => json(decisionBody({})));
  const result = await engine({ fetchImpl: fetch }).decide(request({ questions: {} }));
  assert.equal(calls.length, 0);
  assert.deepEqual(result.answers, {});
});

test("a missing answer, a wrong primitive and an invalid choice are invalid responses, never verdicts", async () => {
  const missing = fakeFetch(() => json(decisionBody({})));
  const missingResult = await engine({ fetchImpl: missing.fetch }).decide(request());
  assert.equal(missingResult.answers.refund!.status, "invalid_response");

  const wrongType = fakeFetch(() => json(decisionBody({ refund: { type: "choice", choice: "yes", probabilities: { yes: 1 } } })));
  const wrongTypeResult = await engine({ fetchImpl: wrongType.fetch }).decide(request());
  assert.equal(wrongTypeResult.answers.refund!.status, "invalid_response");

  const badChoice = fakeFetch(() => json(decisionBody({ team: { type: "choice", choice: "legal" } })));
  const badChoiceResult = await engine({ fetchImpl: badChoice.fetch }).decide(request({ questions: { team: CHOICE } }));
  assert.equal(badChoiceResult.answers.team!.status, "invalid_response");
});

test("bad probabilities, a contradictory choice and an out-of-range score are invalid responses", () => {
  const choiceWire = toOpenRouterQuestion(CHOICE) as { type: "choice"; instructions: string; criteria: Record<string, string> };
  const base = { spec: CHOICE, wire: choiceWire, model: "typesafe/jev-1.14" };
  assert.equal(normalizeOpenRouterAnswer({ ...base, raw: { type: "choice", choice: "billing", probabilities: { billing: 1.5, support: 0 } } }).status, "invalid_response");
  assert.equal(normalizeOpenRouterAnswer({ ...base, raw: { type: "choice", choice: "billing", probabilities: { billing: 0.3, support: 0.3 } } }).status, "invalid_response", "does not sum to one");
  assert.equal(normalizeOpenRouterAnswer({ ...base, raw: { type: "choice", choice: "billing", probabilities: { billing: 0.1, support: 0.9 } } }).status, "invalid_response", "the chosen value is not the most probable");
  assert.equal(normalizeOpenRouterAnswer({ ...base, raw: { type: "choice", choice: "billing", confidence: 2 } }).status, "invalid_response");

  const scoreWire = toOpenRouterQuestion(SCORE) as { type: "score"; instructions: string; criteria: string[] };
  const labels = ["Cosmetic", "Minor", "Severe"];
  const scoreBase = { spec: SCORE, wire: scoreWire, model: "typesafe/jev-1.14", levelLabels: labels };
  assert.equal(normalizeOpenRouterAnswer({ ...scoreBase, raw: { type: "score", score: 3 } }).status, "invalid_response", "above the last level");
  assert.equal(normalizeOpenRouterAnswer({ ...scoreBase, raw: { type: "score", score: -0.5 } }).status, "invalid_response", "below the first level");
  assert.equal(
    normalizeOpenRouterAnswer({ ...scoreBase, raw: { type: "score", score: 0.2, probabilities: { "0": 0, "1": 0, "2": 1 } } }).status,
    "invalid_response",
    "the score is not the probability-weighted average of its levels",
  );
});

test("a noul answer without a probability between 0 and 1 is invalid, and an answer with no probabilities is not given any", () => {
  const wire = toOpenRouterQuestion(NOUL) as { type: "noul"; instructions: string };
  assert.equal(normalizeOpenRouterAnswer({ spec: NOUL, wire, raw: { type: "noul" }, model: "m" }).status, "invalid_response");
  assert.equal(normalizeOpenRouterAnswer({ spec: NOUL, wire, raw: { type: "noul", noul: 1.2 }, model: "m" }).status, "invalid_response");
  const score = normalizeOpenRouterAnswer({
    spec: SCORE,
    wire: toOpenRouterQuestion(SCORE) as { type: "score"; instructions: string; criteria: string[] },
    raw: { type: "score", score: 1 },
    model: "m",
    levelLabels: ["Cosmetic", "Minor", "Severe"],
  });
  assert.equal(score.status, "answered");
  assert.equal((score as { probabilities?: unknown }).probabilities, undefined, "no probabilities are invented when the provider gave none");
});

test("an unverified or aliased model is refused before any request, and names the verified models", async () => {
  for (const model of ["typesafe/jev-9.9", "~typesafe/jev-latest", "not a model", ""]) {
    const { fetch, calls } = fakeFetch(() => json(decisionBody({})));
    const result = await engine({ fetchImpl: fetch, store: { ...noCheck, async workspaceModel() { return model; } } }).decide(request());
    assert.equal(calls.length, 0, `no request for '${model}'`);
    assert.equal(result.failure?.kind, "unknown_model");
    assert.equal(result.answers.refund!.status, "unsupported");
  }
  const refused = validateDecisionModel("typesafe/jev-9.9");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /typesafe\/jev-1\.14, typesafe\/jev-1\.13/);
});

test("an unknown question primitive is refused for that question only, and nothing is sent for it", async () => {
  const { fetch, calls } = fakeFetch(() => json(decisionBody({ refund: { type: "noul", noul: 0.4 } })));
  const boxQuestion = { ...NOUL, type: "box" } as unknown as JevQuestionSpec;
  const result = await engine({ fetchImpl: fetch }).decide(request({ questions: { refund: NOUL, box: boxQuestion } }));
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]!.body.questions as object), ["refund"], "the unknown primitive is not sent");
  assert.equal(result.answers.box!.status, "unsupported");
});

test("a required image the engine cannot take is refused before any request, with no answer claimed", async () => {
  const { fetch, calls } = fakeFetch(() => json(decisionBody({ refund: { type: "noul", noul: 0.4 } })));
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  const result = await engine({ fetchImpl: fetch }).decide(request({ images: [{ bytes: gif, label: "Frame 1" }], imagePolicy: "required" }));
  assert.equal(calls.length, 0);
  assert.equal(result.failure?.kind, "unsupported_input");
  assert.equal(result.answers.refund!.status, "unsupported");
});

test("an optional image that cannot be sent is left out, the omission is recorded, and the text decision still runs", async () => {
  const { fetch, calls } = fakeFetch(() => json(decisionBody({ refund: { type: "noul", noul: 0.4 } })));
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  const result = await engine({ fetchImpl: fetch }).decide(request({ images: [{ bytes: gif }], imagePolicy: "optional" }));
  assert.equal(calls.length, 1, "the text decision is still made");
  assert.equal(result.imagesOmitted, 1, "the omission is recorded, not hidden");
  assert.equal(result.imageCount, 1);
  assert.equal(result.inputModality, "text");
});

test("a PNG image is sent as an image_url part with its data URL, and the decision is recorded as text plus image", async () => {
  const { fetch, calls } = fakeFetch(() => json(decisionBody({ refund: { type: "noul", noul: 0.7 } })));
  const png = contractPngBytes();
  const result = await engine({ fetchImpl: fetch }).decide(request({ images: [{ bytes: png, label: "Frame at 3.2s" }], imagePolicy: "required" }));
  const state = calls[0]!.body.state as Array<unknown>;
  assert.ok(Array.isArray(state), "an image request sends its state as parts");
  assert.equal(state[1], "Frame at 3.2s", "the image's label sits before the image");
  const image = state[2] as { type: string; image_url: { url: string } };
  assert.equal(image.type, "image_url");
  assert.match(image.image_url.url, /^data:image\/png;base64,/);
  assert.equal(result.inputModality, "text+image");
  assert.equal(result.imageCount, 1);
  assert.equal(result.imagesOmitted, 0);
});

test("a model verified as text only does not receive an image, and a required image is refused for it", () => {
  assert.equal(capabilitiesOfModel("typesafe/jev-1.13").images, false);
  assert.equal(capabilitiesOfModel("typesafe/jev-1.14").images, true);
  assert.deepEqual(capabilitiesOfModel("typesafe/unknown").questionKinds, [], "an unverified model supports no question");
});

test("a rate limit, an authentication failure, a server error and a missing model are each reported as their own failure", async () => {
  const cases: Array<[number, string]> = [
    [401, "authentication"],
    [403, "authentication"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
    [503, "provider_unavailable"],
    [404, "unknown_model"],
    [400, "invalid_request"],
  ];
  for (const [status, kind] of cases) {
    const { fetch } = fakeFetch(() => json({ error: "nope" }, status));
    const result = await engine({ fetchImpl: fetch }).decide(request());
    assert.equal(result.failure?.kind, kind, `HTTP ${status}`);
    assert.equal(result.answers.refund!.status, "provider_error");
  }
  assert.equal(failureKindForStatus(400, "unknown model 'x'"), "unknown_model");
});

test("a timeout, a network error and a body that is not JSON are each reported, and a failed call is never retried", async () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const timedOut = fakeFetch(() => timeout);
  const timeoutResult = await engine({ fetchImpl: timedOut.fetch }).decide(request());
  assert.equal(timeoutResult.failure?.kind, "timeout");
  assert.equal(timedOut.calls.length, 1, "a timed-out call is not sent again, because it may have been billed");

  const network = fakeFetch(() => new TypeError("fetch failed"));
  const networkResult = await engine({ fetchImpl: network.fetch }).decide(request());
  assert.equal(networkResult.failure?.kind, "network");
  assert.equal(network.calls.length, 1);

  const serverError = fakeFetch(() => json({ error: "temporarily unavailable" }, 500));
  await engine({ fetchImpl: serverError.fetch }).decide(request());
  assert.equal(serverError.calls.length, 1, "a server error is reported, not retried");

  const notJson = fakeFetch(() => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }));
  const notJsonResult = await engine({ fetchImpl: notJson.fetch }).decide(request());
  assert.equal(notJsonResult.failure?.kind, "invalid_response");
  assert.equal(notJsonResult.answers.refund!.status, "invalid_response");

  const noAnswers = fakeFetch(() => json({ model: "typesafe/jev-1.14", usage: {} }));
  const noAnswersResult = await engine({ fetchImpl: noAnswers.fetch }).decide(request());
  assert.equal(noAnswersResult.failure?.kind, "invalid_response");
});

test("no key in an error, an answer or a result: a key echoed by the provider is redacted", async () => {
  const echoed = fakeFetch(() => json({ error: `bad key ${KEY}` }, 401));
  const result = await engine({ fetchImpl: echoed.fetch }).decide(request());
  const text = JSON.stringify(result);
  assert.equal(text.includes(KEY), false, "the key appears nowhere in the result");
  assert.equal(text.includes("sk-or-v1-fixture-secret"), false);
  assert.equal(safeProviderText(`x ${KEY} y Bearer abc.def`), "x [redacted] y Bearer [redacted]");
});

test("a workspace with no saved key makes no call, and says so; no other workspace's key is used", async () => {
  const { fetch, calls } = fakeFetch(() => json(decisionBody({ refund: { type: "noul", noul: 0.4 } })));
  const result = await engine({ fetchImpl: fetch }).decide(request({ organizationId: OTHER_ORG }));
  assert.equal(calls.length, 0);
  assert.equal(result.failure?.kind, "not_configured");
  assert.equal(result.answers.refund!.status, "not_configured");
});

test("the model is the workspace's own choice, then the deployment's, then the pinned default; an invalid choice is refused, not replaced", () => {
  assert.deepEqual(resolveOpenRouterDecisionModel({ workspace: "typesafe/jev-1.13", deployment: "typesafe/jev-1.14" }), { ok: true, model: "typesafe/jev-1.13", source: "workspace" });
  assert.deepEqual(resolveOpenRouterDecisionModel({ workspace: null, deployment: "typesafe/jev-1.13" }), { ok: true, model: "typesafe/jev-1.13", source: "deployment" });
  assert.deepEqual(resolveOpenRouterDecisionModel({ workspace: null, deployment: undefined }), { ok: true, model: OPENROUTER_DECISIONS_DEFAULT_MODEL, source: "default" });
  const invalid = resolveOpenRouterDecisionModel({ workspace: "typesafe/jev-9.9", deployment: "typesafe/jev-1.14" });
  assert.equal(invalid.ok, false, "an invalid workspace choice is reported, and the deployment default does not replace it");
  const badDeployment = resolveOpenRouterDecisionModel({ workspace: null, deployment: "~typesafe/jev-latest" });
  assert.equal(badDeployment.ok, false);
});

test("health: no key is not configured, an unverified model is unsupported, a key without a passed check is configured, and only a passed check for this key and model is ready", async () => {
  const none = await engine({ keys: { async keyFor() { return { secret: null, fingerprint: "", reason: "No key is saved." }; } } }).healthFor(ORG);
  assert.equal(none.status, "NOT_CONFIGURED");

  const unverified = await engine({ store: { ...noCheck, async workspaceModel() { return "typesafe/jev-9.9"; } } }).healthFor(ORG);
  assert.equal(unverified.status, "UNSUPPORTED");

  const configured = await engine().healthFor(ORG);
  assert.equal(configured.status, "CONFIGURED", "a saved key alone is not ready");

  const passed: OpenRouterCheckRecord = {
    status: "passed", model: OPENROUTER_DECISIONS_DEFAULT_MODEL, keyFingerprint: KEY_FINGERPRINT, message: "ok", checkedAt: "2026-10-24T12:00:00.000Z",
    returnedModel: null, upstreamProvider: null, providerRequestId: null,
  };
  assert.equal((await engine({ store: { ...noCheck, async latestCheck() { return passed; } } }).healthFor(ORG)).status, "READY");

  const otherKey = { ...passed, keyFingerprint: "sk-or-…0000" };
  assert.equal((await engine({ store: { ...noCheck, async latestCheck() { return otherKey; } } }).healthFor(ORG)).status, "CONFIGURED", "a changed key makes an earlier pass stop counting");

  const otherModel = { ...passed, model: "typesafe/jev-1.13" };
  assert.equal((await engine({ store: { ...noCheck, async latestCheck() { return otherModel; } } }).healthFor(ORG)).status, "CONFIGURED", "a changed model makes an earlier pass stop counting");

  const failed = { ...passed, status: "failed" as const, message: "HTTP 401" };
  const failedHealth = await engine({ store: { ...noCheck, async latestCheck() { return failed; } } }).healthFor(ORG);
  assert.equal(failedHealth.status, "CONFIGURED");
  assert.match(failedHealth.message, /last connection test failed/);

  const unreadable = await engine({ store: { ...noCheck, async latestCheck() { throw new Error("connection refused"); } } }).healthFor(ORG);
  assert.equal(unreadable.status, "UNAVAILABLE");
});

test("a connection test sends one real request and reports the outcome; with no key it sends nothing", async () => {
  const ok = fakeFetch(() => json(decisionBody({ connection_test: { type: "noul", noul: 0.95 } })));
  const passed = await engine({ fetchImpl: ok.fetch }).connectionCheck(ORG);
  assert.equal(ok.calls.length, 1);
  assert.equal(passed.kind, "checked");
  if (passed.kind !== "checked") return;
  assert.equal(passed.status, "passed");
  assert.equal(passed.keyFingerprint, KEY_FINGERPRINT);
  assert.equal(passed.returnedModel, "typesafe/jev-1.14-20261014");
  assert.equal(passed.upstreamProvider, "TypeSafe");

  const rejected = fakeFetch(() => json({ error: "no" }, 401));
  const failed = await engine({ fetchImpl: rejected.fetch }).connectionCheck(ORG);
  assert.equal(failed.kind === "checked" && failed.status, "failed");

  const none = fakeFetch(() => json({}));
  const notRun = await engine({ fetchImpl: none.fetch, keys: { async keyFor() { return { secret: null, fingerprint: "", reason: "No key." }; } } }).connectionCheck(ORG);
  assert.equal(none.calls.length, 0, "no key, no request");
  assert.equal(notRun.kind, "not_run");
});

test("a workspace's decisions read only that workspace's key and model", async () => {
  const seen: string[] = [];
  const keys: OpenRouterKeySource = {
    async keyFor(organizationId) {
      seen.push(`key:${organizationId}`);
      return { secret: KEY, fingerprint: KEY_FINGERPRINT, reason: "" };
    },
  };
  const store: OpenRouterCheckStore = {
    async workspaceModel(organizationId) {
      seen.push(`model:${organizationId}`);
      return null;
    },
    async latestCheck() {
      return null;
    },
  };
  const { fetch } = fakeFetch(() => json(decisionBody({ refund: { type: "noul", noul: 0.4 } })));
  await engine({ fetchImpl: fetch, keys, store }).decide(request());
  assert.ok(seen.every((entry) => entry.endsWith(`:${ORG}`)), `every read is scoped to ${ORG}: ${seen.join(", ")}`);
});
