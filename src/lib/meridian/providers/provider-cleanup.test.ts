import assert from "node:assert/strict";
import test from "node:test";
import { generateNanoBananaImage } from "./nano-banana.server.ts";
import { videoGenerationStatus } from "../video/provider.ts";

// The OpenRouter chat path's selection and model checks are in generation.test.ts. This file keeps the other providers.

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
    apiKey: "google-test-key",
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
