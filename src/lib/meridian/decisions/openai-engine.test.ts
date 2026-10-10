import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiDecisionsEngine, OPENAI_DECISIONS_MAX_IMAGES, toWireQuestion } from "./openai-engine.ts";
import { CONTRACT_CHOICE, CONTRACT_KEYS, CONTRACT_SCORE, contractPngBytes, contractRequest } from "./contract-fixtures.ts";

// These tests use fixtures shaped like the documented Decisions contract. They do not call the live API.

type Captured = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

/** Answers every asked question by name, the way the documented response does. */
function echoFetch(calls: Captured[], options: { model?: string; usage?: unknown } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body, headers: init?.headers as Record<string, string> });
    const questions = body.questions as Array<Record<string, unknown>>;
    const answers = questions.map((q) => {
      if (q.type === "predicate") return { type: "predicate", name: q.name, probability: 0.91 };
      if (q.type === "choice") {
        return {
          type: "choice",
          name: q.name,
          choice: "organic_catalyst",
          probabilities: [
            { value: "organic_catalyst", probability: 0.8 },
            { value: "bolted_on_cta", probability: 0.2 },
          ],
          confidence: 0.8,
        };
      }
      return {
        type: "score",
        name: q.name,
        score: 3.4,
        probabilities: [{ value: 3, label: "4", probability: 0.6 }, { value: 4, label: "5", probability: 0.4 }],
        confidence: 0.7,
      };
    });
    return new Response(
      JSON.stringify({ model: options.model ?? "gpt-6-luna", answers, usage: options.usage ?? undefined }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function staticFetch(status: number, text: string, calls: Captured[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    return new Response(text, { status });
  }) as typeof fetch;
}

const CONFIG = { apiKey: "sk-test-contract-key-1234", model: "gpt-6-luna", maxRetries: 0 };
const noSleep = async () => {};

test("predicate, choice, and score questions are sent as typed Decisions questions and normalized", async () => {
  const calls: Captured[] = [];
  const engine = new OpenAiDecisionsEngine({ config: CONFIG, fetchImpl: echoFetch(calls), sleep: noSleep });
  const result = await engine.decide(contractRequest());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/decisions");
  assert.equal(calls[0].body.model, "gpt-6-luna");
  const questions = calls[0].body.questions as Array<Record<string, any>>;
  assert.deepEqual(questions.map((q) => q.type), ["predicate", "choice", "score"]);
  assert.deepEqual(new Set(questions.map((q) => q.name)).size, 3, "every question has a unique name");
  assert.equal(questions[1].choices.length, 2, "choice values are sent as choices");
  assert.equal(questions[2].levels.length, 5, "score levels are sent in order");
  assert.equal(questions[2].levels[0].label, "1");

  assert.equal(result.failure, undefined);
  const predicate = result.answers[CONTRACT_KEYS.predicate];
  assert.equal(predicate.status, "answered");
  assert.equal(predicate.probability, 0.91);
  assert.equal(predicate.semantics, "probability");
  assert.equal(predicate.calibrationStatus, "uncalibrated", "no provider number is presented as calibrated");

  const choice = result.answers[CONTRACT_KEYS.choice];
  assert.equal(choice.status, "answered");
  assert.equal(choice.choice, "organic_catalyst");
  assert.equal(choice.semantics, "categorical");
  assert.equal(choice.probability, undefined, "a choice never gets a fabricated probability");

  const score = result.answers[CONTRACT_KEYS.score];
  assert.equal(score.status, "answered");
  assert.equal(score.score, 3.4);
  assert.equal(score.semantics, "ordered_score");
  assert.deepEqual(Object.keys(score.legend ?? {}), ["0", "1", "2", "3", "4"]);
});

test("images are sent as validated data URLs in one user message, never as URLs", async () => {
  const calls: Captured[] = [];
  const engine = new OpenAiDecisionsEngine({ config: CONFIG, fetchImpl: echoFetch(calls), sleep: noSleep });
  const result = await engine.decide(
    contractRequest({
      images: [{ bytes: contractPngBytes(), label: "Frame at 3.2s" }],
      imagePolicy: "required",
    }),
  );
  const input = calls[0].body.input as Array<{ role: string; content: Array<Record<string, string>> }>;
  assert.equal(input[0].role, "user");
  const imagePart = input[0].content.find((part) => part.type === "input_image");
  assert.ok(imagePart?.image_url.startsWith("data:image/png;base64,"), "the image is a PNG data URL");
  assert.ok(!JSON.stringify(calls[0].body).includes("http"), "no hosted URL is sent for private media");
  assert.equal(result.inputModality, "text+image");
  assert.equal(result.imageCount, 1);
  assert.equal(result.answers[CONTRACT_KEYS.predicate].status, "answered");
});

test("invalid or oversized images fail before any request is made", async () => {
  const calls: Captured[] = [];
  const engine = new OpenAiDecisionsEngine({ config: CONFIG, fetchImpl: echoFetch(calls), sleep: noSleep });

  const notAnImage = await engine.decide(
    contractRequest({ images: [{ bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }] }),
  );
  assert.equal(notAnImage.failure?.kind, "unsupported_input");
  assert.equal(notAnImage.answers[CONTRACT_KEYS.predicate].status, "unsupported");

  const tooMany = Array.from({ length: OPENAI_DECISIONS_MAX_IMAGES + 1 }, () => ({ bytes: contractPngBytes() }));
  const over = await engine.decide(contractRequest({ images: tooMany }));
  assert.equal(over.failure?.kind, "unsupported_input");
  assert.equal(calls.length, 0, "no request was sent for either invalid set");
});

test("with no API key the engine reports not configured and sends nothing", async () => {
  const calls: Captured[] = [];
  const engine = new OpenAiDecisionsEngine({
    config: { apiKey: "", model: "gpt-6-luna", maxRetries: 0 },
    fetchImpl: echoFetch(calls),
    sleep: noSleep,
  });
  const result = await engine.decide(contractRequest());
  assert.equal(result.failure?.kind, "not_configured");
  assert.equal(result.answers[CONTRACT_KEYS.choice].status, "not_configured");
  assert.equal(calls.length, 0);
  assert.equal((await engine.health()).status, "NOT_CONFIGURED");
});

test("a refusal is recorded as refused, never as an approval", async () => {
  const body = JSON.stringify({
    model: "gpt-6-luna",
    answers: [
      { type: "refusal", name: "q1" },
      { type: "choice", name: "q2", choice: "organic_catalyst", probabilities: [], confidence: 0.5 },
      { type: "score", name: "q3", score: 3, probabilities: [], confidence: 0.5 },
    ],
  });
  const engine = new OpenAiDecisionsEngine({ config: CONFIG, fetchImpl: staticFetch(200, body), sleep: noSleep });
  const result = await engine.decide(contractRequest());
  assert.equal(result.answers[CONTRACT_KEYS.predicate].status, "refused");
  assert.equal(result.answers[CONTRACT_KEYS.predicate].probability, undefined, "a refusal carries no value");
});

test("a missing answer is an invalid response, not a positive decision", async () => {
  const body = JSON.stringify({ model: "gpt-6-luna", answers: [] });
  const engine = new OpenAiDecisionsEngine({ config: CONFIG, fetchImpl: staticFetch(200, body), sleep: noSleep });
  const result = await engine.decide(contractRequest());
  for (const key of Object.keys(contractRequest().questions)) {
    assert.equal(result.answers[key].status, "invalid_response");
    assert.equal(result.answers[key].probability, undefined);
  }
});

test("a malformed answer is not an answer: out-of-set choices, bad probabilities, and out-of-range scores", async () => {
  const body = JSON.stringify({
    model: "gpt-6-luna",
    answers: [
      { type: "predicate", name: "q1", probability: 1.7 },
      { type: "choice", name: "q2", choice: "not_a_defined_value", probabilities: [], confidence: 0.5 },
      { type: "score", name: "q3", score: 9, probabilities: [], confidence: 0.5 },
    ],
  });
  const engine = new OpenAiDecisionsEngine({ config: CONFIG, fetchImpl: staticFetch(200, body), sleep: noSleep });
  const result = await engine.decide(contractRequest());
  assert.equal(result.answers[CONTRACT_KEYS.predicate].status, "invalid_response");
  assert.equal(result.answers[CONTRACT_KEYS.choice].status, "invalid_response");
  assert.equal(result.answers[CONTRACT_KEYS.score].status, "invalid_response");
});

test("a body that is not JSON is an invalid response", async () => {
  const engine = new OpenAiDecisionsEngine({ config: CONFIG, fetchImpl: staticFetch(200, "<html>oops</html>"), sleep: noSleep });
  const result = await engine.decide(contractRequest());
  assert.equal(result.failure?.kind, "invalid_response");
});

test("a rate limit is retried a bounded number of times, then reported as rate limited", async () => {
  const calls: Captured[] = [];
  const sleeps: number[] = [];
  const engine = new OpenAiDecisionsEngine({
    config: { ...CONFIG, maxRetries: 2 },
    fetchImpl: staticFetch(429, "slow down", calls),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const result = await engine.decide(contractRequest());
  assert.equal(calls.length, 3, "one attempt plus two retries, and no more");
  assert.equal(sleeps.length, 2);
  assert.equal(result.failure?.kind, "rate_limited");
  assert.equal(result.answers[CONTRACT_KEYS.predicate].status, "provider_error");
});

test("a timeout is reported once and is not retried, since the request may already have been billed", async () => {
  const calls: Captured[] = [];
  const timingOut = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }) as typeof fetch;
  const engine = new OpenAiDecisionsEngine({ config: { ...CONFIG, maxRetries: 3 }, fetchImpl: timingOut, sleep: noSleep });
  const result = await engine.decide(contractRequest());
  assert.equal(calls.length, 1);
  assert.equal(result.failure?.kind, "timeout");
});

test("an unknown model is reported as an unknown model, and an authentication failure does not leak the key", async () => {
  const unknown = new OpenAiDecisionsEngine({
    config: CONFIG,
    fetchImpl: staticFetch(400, '{"error":{"message":"The model gpt-9 does not exist"}}'),
    sleep: noSleep,
  });
  assert.equal((await unknown.decide(contractRequest())).failure?.kind, "unknown_model");

  const auth = new OpenAiDecisionsEngine({
    config: CONFIG,
    fetchImpl: staticFetch(401, '{"error":"invalid key sk-liveSECRET1234567890 presented"}'),
    sleep: noSleep,
  });
  const failed = await auth.decide(contractRequest());
  assert.equal(failed.failure?.kind, "authentication");
  assert.ok(!failed.failure?.message.includes("liveSECRET"), "the key is not echoed");
});

test("usage and the model the provider returned are recorded", async () => {
  const calls: Captured[] = [];
  const engine = new OpenAiDecisionsEngine({
    config: CONFIG,
    fetchImpl: echoFetch(calls, {
      model: "gpt-6-luna-2026-10",
      usage: {
        input_tokens: 812,
        output_tokens: 90,
        total_tokens: 902,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens_details: { reasoning_tokens: 40 },
      },
    }),
    sleep: noSleep,
  });
  const result = await engine.decide(contractRequest());
  assert.equal(result.requestedModel, "gpt-6-luna");
  assert.equal(result.returnedModel, "gpt-6-luna-2026-10");
  assert.deepEqual(result.usage, { inputTokens: 812, outputTokens: 90, totalTokens: 902, reasoningTokens: 40, cachedInputTokens: 100 });
  assert.equal(result.answers[CONTRACT_KEYS.predicate].model, "gpt-6-luna-2026-10");
});

test("a question the engine cannot express is unsupported, and the other questions are still asked", async () => {
  const calls: Captured[] = [];
  const oneChoice = { ...CONTRACT_CHOICE, criteria: { only: "The only value." } };
  const engine = new OpenAiDecisionsEngine({ config: CONFIG, fetchImpl: echoFetch(calls), sleep: noSleep });
  const result = await engine.decide(contractRequest({ questions: { naturalness: oneChoice, tone: CONTRACT_SCORE } }));
  assert.equal(result.answers.naturalness.status, "unsupported");
  assert.equal(result.answers[CONTRACT_KEYS.score].status, "answered");
  assert.equal((calls[0].body.questions as unknown[]).length, 1, "only the expressible question is sent");
  assert.ok("unsupported" in toWireQuestion("q1", oneChoice));
});

test("the tenant is sent as a one-way hash, not as its identifier", async () => {
  const calls: Captured[] = [];
  const engine = new OpenAiDecisionsEngine({ config: CONFIG, fetchImpl: echoFetch(calls), sleep: noSleep });
  await engine.decide(contractRequest({ organizationId: "org-private-tenant-42" }));
  const identifier = String(calls[0].body.safety_identifier);
  assert.equal(identifier.length, 64);
  assert.ok(!JSON.stringify(calls[0].body).includes("org-private-tenant-42"));
});

test("the engine declares its capabilities truthfully: text and images, three question kinds, usage reported", () => {
  const capabilities = new OpenAiDecisionsEngine({ config: CONFIG }).capabilities();
  assert.deepEqual(capabilities.questionKinds, ["predicate", "choice", "score"]);
  assert.deepEqual(capabilities.inputModalities, ["text", "image"]);
  assert.equal(capabilities.maxImages, 128);
  assert.equal(capabilities.reportsUsage, true);
  assert.equal(capabilities.semantics.predicate, "probability");
});
