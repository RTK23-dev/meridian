// Reference analysis through OpenRouter: the provider sends the fixed instructions and the images to the workspace's chosen model through
// the guarded generation path, and reads the answer as strictly as the Gemini provider. No test reaches the network: the generation call
// is a stand-in that records what it was asked and returns a recorded answer.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { solidFrame } from "../video/inspect.ts";
import type { GenerationResult } from "../providers/chat.server.ts";
import { OPENROUTER_PERCEPTION_ID, OpenRouterPerceptionProvider, perceptionAnswerText } from "./openrouter.ts";
import type { PerceptionCallContext, PerceptionMedia } from "./types.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const frame = (timestampMs: number): PerceptionMedia => {
  const bytes = solidFrame(16, 16, [200, 40, 40]);
  return { id: `frame-${timestampMs}`, bytes, mimeType: "image/png", sha256: sha(bytes), timestampMs };
};
const context: PerceptionCallContext = { sql: {} as PerceptionCallContext["sql"], organizationId: "org-1", brandId: "brand-1", runId: randomUUID() };

function answering(content: string | GenerationResult) {
  const calls: Array<{ organizationId: string | null; task: string; input: Parameters<typeof import("../providers/chat.server.ts").completeGenerationTask>[2] }> = [];
  const complete = (async (organizationId, task, input) => {
    calls.push({ organizationId, task, input });
    if (typeof content !== "string") return content;
    return {
      ok: true, content, latencyMs: 12, tokens: 300, provider: "openrouter", model: "google/gemini-3.8-flash", modelSource: "workspace",
      returnedModel: "google/gemini-3.8-flash", generationId: "gen-1", costUsd: 0.0004,
    } satisfies GenerationResult;
  }) as typeof import("../providers/chat.server.ts").completeGenerationTask;
  return { complete, calls };
}

test("the images and the fixed instructions go to the Reference analysis model, and the answer becomes one observation per item", async () => {
  const media = [frame(0), frame(1500)];
  const { complete, calls } = answering(JSON.stringify([
    { index: 0, shotType: "close_up", productPresence: true, ocrText: "Lather bar" },
    { index: 1, shotType: "wide_shot", productPresence: null, sharpness: "soft" },
  ]));
  const provider = new OpenRouterPerceptionProvider("google/gemini-3.8-flash", { complete });
  const result = await provider.perceive({ kind: "video_frames", media }, { apiKey: "", context });
  assert.equal(result.status, "observed");
  if (result.status !== "observed") return;
  assert.equal(result.providerId, OPENROUTER_PERCEPTION_ID);
  assert.equal(result.observations.length, 2);
  assert.equal(result.observations[0]?.shotType, "close_up");
  assert.equal(result.observations[1]?.productPresence, null, "an unknown stays unknown");
  assert.equal(result.observations[1]?.timestampMs, 1500, "the real timestamp is kept");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.task, "reference_analysis");
  assert.equal(calls[0]?.organizationId, "org-1");
  const parts = calls[0]?.input.user;
  assert.ok(Array.isArray(parts));
  assert.equal(parts.filter((part) => part.type === "image_url").length, 2);
  assert.ok(parts.every((part) => part.type !== "image_url" || part.image_url.url.startsWith("data:image/png;base64,")), "images go as data, not URLs");
  assert.match(String(parts[0]?.type === "text" ? parts[0].text : ""), /sampled from one video/);
  assert.equal(calls[0]?.input.record.correlationId, context.runId, "the hold is tied to the perception run");
});

test("an answer in a code fence or under an observations key is read; anything else is a failure, never a guess", async () => {
  assert.equal(perceptionAnswerText("```json\n[{\"index\":0}]\n```"), "[{\"index\":0}]");
  assert.equal(perceptionAnswerText("{\"observations\":[{\"index\":0}]}"), "[{\"index\":0}]");
  const missing = new OpenRouterPerceptionProvider("m/x", { complete: answering(JSON.stringify([{ index: 0 }])).complete });
  const result = await missing.perceive({ kind: "video_frames", media: [frame(0), frame(500)] }, { apiKey: "", context });
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.failureKind, "invalid_response");
    assert.match(result.message, /No observation was reported for media 2/);
  }
});

test("a refused or uncertain call is reported as failed with its reason, and nothing is sent without a workspace", async () => {
  const refused = answering({ ok: false, status: "unavailable", provider: "openrouter", error: "Choose a model that takes images for Reference analysis in Settings.", model: null });
  const notChosen = await new OpenRouterPerceptionProvider("m/x", { complete: refused.complete }).perceive({ kind: "image", media: [frame(0)] }, { apiKey: "", context });
  assert.equal(notChosen.status === "failed" && notChosen.failureKind, "not_configured");
  const uncertain = answering({ ok: false, status: "uncertain", provider: "openrouter", error: "OpenRouter timed out.", model: "m/x" });
  const timedOut = await new OpenRouterPerceptionProvider("m/x", { complete: uncertain.complete }).perceive({ kind: "image", media: [frame(0)] }, { apiKey: "", context });
  assert.equal(timedOut.status === "failed" && timedOut.failureKind, "timeout");
  const unused = answering("[]");
  const noContext = await new OpenRouterPerceptionProvider("m/x", { complete: unused.complete }).perceive({ kind: "image", media: [frame(0)] }, { apiKey: "" });
  assert.equal(noContext.status, "failed");
  assert.equal(unused.calls.length, 0, "no call without a workspace to hold the budget against");
});

test("media that does not match its recorded hash is refused before anything is sent", async () => {
  const { complete, calls } = answering("[]");
  const tampered = { ...frame(0), sha256: "0".repeat(64) };
  const result = await new OpenRouterPerceptionProvider("m/x", { complete }).perceive({ kind: "image", media: [tampered] }, { apiKey: "", context });
  assert.equal(result.status === "failed" && result.failureKind, "unsupported_media");
  assert.equal(calls.length, 0);
});

test("the key check is the workspace's OpenRouter key, from the resolver, with no request", async () => {
  const ready = new OpenRouterPerceptionProvider("m/x", { credentialStatus: async () => ({ status: "ready", reason: "", fingerprint: "...abcd" }) });
  assert.deepEqual(await ready.resolveCredential({} as PerceptionCallContext["sql"], "org-1"), { status: "ready", source: "openrouter", apiKey: "" });
  const none = new OpenRouterPerceptionProvider("m/x", { credentialStatus: async () => ({ status: "not_configured", reason: "No OpenRouter key is saved.", fingerprint: null }) });
  assert.deepEqual(await none.resolveCredential({} as PerceptionCallContext["sql"], "org-1"), { status: "not_configured", reason: "No OpenRouter key is saved." });
});
