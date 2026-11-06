// Studio images through OpenRouter: the provider sends OpenRouter's image request through the gateway with the workspace's chosen model,
// reads the answer as untrusted, records only a reported cost, and is ready only with a usable key and a chosen model. The router prefers
// it when the workspace chose a model. No test reaches the network: the gateway is a stand-in.

import assert from "node:assert/strict";
import test from "node:test";
import { solidFrame } from "../video/inspect.ts";
import type { GatewayCall, GatewayResult } from "../../../engine/gateway/gateway.ts";
import { OPENROUTER_IMAGE_PROVIDER_ID, OpenRouterStudioImageProvider, pngSize } from "./openrouter-image.ts";
import { ProductionRouter } from "./router.ts";
import type { ImageGenerationInput, ProductionImageProvider } from "./image-providers.ts";
import type { CreativeSpec } from "./types.ts";

const png = solidFrame(12, 20, [10, 120, 200]);
const answer = (body: unknown, status = 200): GatewayResult => ({
  status: "ok",
  response: { status, headers: {}, body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)) },
});
const input: ImageGenerationInput = { prompt: "a bar of soap on a wet stone", seed: "s1", promptVersion: "v1", model: "studio-image-model", aspectRatio: "9:16", organizationId: "org-1" };
const ready = async () => ({ status: "ready" as const, reason: "", fingerprint: "...abcd" });

function provider(result: GatewayResult | (() => never), stored: string | null = "google/gemini-nano-banana-2.1") {
  const calls: GatewayCall[] = [];
  const gateway = {
    call: async (call: GatewayCall) => {
      calls.push(call);
      return typeof result === "function" ? result() : result;
    },
  };
  return { calls, provider: new OpenRouterStudioImageProvider({ gateway, stored: async () => stored, credentialStatus: ready }) };
}

test("the image request goes to OpenRouter with the workspace's chosen model, and the PNG comes back with its size and reported cost", async () => {
  const { calls, provider: p } = provider(answer({ data: [{ b64_json: Buffer.from(png).toString("base64"), media_type: "image/png" }], usage: { cost: 0.039 } }));
  const outcome = await p.generate(input);
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") return;
  assert.equal(outcome.model, "google/gemini-nano-banana-2.1", "the outcome names the model that made it, not the seat");
  assert.equal(outcome.width, 12);
  assert.equal(outcome.height, 20);
  assert.equal(outcome.mediaType, "image/png");
  assert.ok(Math.abs((outcome.costCents ?? 0) - 3.9) < 1e-9, "the reported cost, in cents");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.provider, "openrouter");
  assert.equal(calls[0]?.organizationId, "org-1", "the gateway uses this workspace's key");
  assert.equal(calls[0]?.path, "/images");
  const body = JSON.parse(String(calls[0]?.body));
  assert.deepEqual(body, { model: "google/gemini-nano-banana-2.1", prompt: input.prompt, n: 1, aspect_ratio: "9:16", output_format: "png" });
});

test("no reported cost is recorded as none, never as zero", async () => {
  const { provider: p } = provider(answer({ data: [{ b64_json: Buffer.from(png).toString("base64") }] }));
  const outcome = await p.generate(input);
  assert.equal(outcome.status === "ready" && outcome.costCents, null);
});

test("nothing is sent without a chosen model, a workspace, or a recorded aspect ratio", async () => {
  const none = provider(answer({}), null);
  assert.equal((await none.provider.generate(input)).status, "NOT_CONNECTED");
  assert.equal((await none.provider.generate({ ...input, organizationId: undefined })).status, "NOT_CONNECTED");
  const chosen = provider(answer({}));
  const fourFive = await chosen.provider.generate({ ...input, aspectRatio: "4:5" });
  assert.equal(fourFive.status, "NOT_CONNECTED");
  assert.equal(none.calls.length + chosen.calls.length, 0, "no request was made");
});

test("a key the gateway cannot use is not connected; an error status or an unreadable answer is a failure (the reservation stays held)", async () => {
  assert.equal((await provider({ status: "not_connected", reason: "No OpenRouter key is saved." }).provider.generate(input)).status, "NOT_CONNECTED");
  assert.equal((await provider(answer({ error: "busy" }, 503)).provider.generate(input)).status, "failed");
  assert.equal((await provider(answer("not json")).provider.generate(input)).status, "failed");
  assert.equal((await provider(answer({ data: [{ b64_json: "%%%" }] })).provider.generate(input)).status, "failed");
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const notPng = await provider(answer({ data: [{ b64_json: Buffer.from(jpeg).toString("base64") }] })).provider.generate(input);
  assert.equal(notPng.status, "failed", "only the PNG that was asked for is accepted");
  const thrown = await provider(() => { throw new Error("socket reset"); }).provider.generate(input);
  assert.equal(thrown.status, "failed", "a request that may have reached OpenRouter is a failure, not a refusal");
});

test("the provider is ready for a workspace only with a usable key and a chosen model", async () => {
  const chosen = new OpenRouterStudioImageProvider({ stored: async () => "google/gemini-nano-banana-2.1", credentialStatus: ready });
  assert.equal((await chosen.healthFor("org-1")).state, "CONFIGURED");
  const notChosen = new OpenRouterStudioImageProvider({ stored: async () => null, credentialStatus: ready });
  assert.equal((await notChosen.healthFor("org-1")).state, "NOT_CONFIGURED");
  const noKey = new OpenRouterStudioImageProvider({ stored: async () => "google/gemini-nano-banana-2.1", credentialStatus: async () => ({ status: "not_configured", reason: "No OpenRouter key.", fingerprint: null }) });
  assert.equal((await noKey.healthFor("org-1")).state, "NOT_CONFIGURED");
  assert.equal((await chosen.health()).state, "NOT_CONFIGURED", "without a workspace nothing can be checked");
  assert.deepEqual(pngSize(png), { width: 12, height: 20 });
});

test("the router uses OpenRouter for Studio images when the workspace chose a model, before the Google key", async () => {
  const google: ProductionImageProvider = {
    id: "google_nano_banana",
    capabilities: { zeroSpend: false },
    health: async () => ({ id: "google_nano_banana", state: "CONFIGURED", capabilities: ["text-to-image"], detail: "", checkedAt: new Date().toISOString() }),
    generate: async () => { throw new Error("not called by selection"); },
  };
  const spec = { id: "s", organizationId: "org-1", brandId: "b", title: "t", modality: "image", format: "static", aspectRatio: "9:16", durationTargetSeconds: 0, hookLine: "h", script: "s", scenes: [] } as CreativeSpec;
  const chosen = new OpenRouterStudioImageProvider({ stored: async () => "google/gemini-nano-banana-2.1", credentialStatus: ready });
  const withChoice = new ProductionRouter({ runtime: "testing", providers: [], imageProviders: [google, chosen] });
  const picked = await withChoice.selectImageForSpec(spec, { allowUnknownCost: true });
  assert.equal(picked.provider.id, OPENROUTER_IMAGE_PROVIDER_ID);
  const notChosen = new OpenRouterStudioImageProvider({ stored: async () => null, credentialStatus: ready });
  const withoutChoice = new ProductionRouter({ runtime: "testing", providers: [], imageProviders: [google, notChosen] });
  assert.equal((await withoutChoice.selectImageForSpec(spec, { allowUnknownCost: true })).provider.id, "google_nano_banana");
});
