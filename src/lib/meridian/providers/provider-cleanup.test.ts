import assert from "node:assert/strict";
import test from "node:test";
import { activeChatProvider, providerStatus } from "./chat.server.ts";
import { generateNanoBananaImage } from "./nano-banana.server.ts";
import { videoGenerationStatus } from "../video/provider.ts";

test("OpenRouter alone is selected even when the legacy xAI key is present", () => {
  const before = { open: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL, xai: process.env.XAI_API_KEY };
  process.env.OPENROUTER_API_KEY = "router-test-key";
  process.env.OPENROUTER_MODEL = "provider/test-model";
  process.env.XAI_API_KEY = "legacy-key-must-not-select";
  try {
    assert.equal(activeChatProvider()?.id, "openrouter");
    assert.deepEqual(providerStatus(), { configured: true, provider: "openrouter", model: "provider/test-model" });
  } finally {
    if (before.open === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = before.open;
    if (before.model === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = before.model;
    if (before.xai === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = before.xai;
  }
});

test("a key without an OpenRouter model is explicitly disconnected", () => {
  const before = { open: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL, xai: process.env.XAI_API_KEY };
  process.env.OPENROUTER_API_KEY = "router-test-key";
  delete process.env.OPENROUTER_MODEL;
  process.env.XAI_API_KEY = "legacy-key-must-not-be-used";
  try {
    assert.equal(activeChatProvider(), null);
    assert.deepEqual(providerStatus(), { configured: false, provider: "none", model: "" });
  } finally {
    if (before.open === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = before.open;
    if (before.model === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = before.model;
    if (before.xai === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = before.xai;
  }
});

test("Nano Banana without credentials is optional and returns no image", async () => {
  const result = await generateNanoBananaImage({ prompt: "test", promptVersion: "test", env: {} });
  assert.equal(result.status, "NOT_CONNECTED");
  assert.equal(result.provider, "google:nano-banana");
});

test("Nano Banana stores no URL-only substitute and returns verified image bytes", async () => {
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  new DataView(png.buffer).setUint32(16, 512);
  new DataView(png.buffer).setUint32(20, 1024);
  const result = await generateNanoBananaImage({
    prompt: "brand-safe image",
    promptVersion: "test-v1",
    env: { GOOGLE_AI_STUDIO_API_KEY: "google-test-key" },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/interactions");
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "google-test-key");
      return new Response(JSON.stringify({ output_image: { data: Buffer.from(png).toString("base64"), mime_type: "image/png" } }), { status: 200 });
    },
  });
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.provider, "google:nano-banana");
    assert.equal(result.width, 512);
    assert.equal(result.height, 1024);
    assert.equal(result.sha256.length, 64);
  }
});

test("Hypit is the only configured production video provider", () => {
  assert.equal(videoGenerationStatus().status, "NOT_CONNECTED");
  assert.equal(videoGenerationStatus({ baseUrl: "https://hypit.example" }).provider, "hypit");
});
