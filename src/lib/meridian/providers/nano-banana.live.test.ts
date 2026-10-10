import assert from "node:assert/strict";
import test from "node:test";
import { ProviderConfigResolver } from "../config/resolver.ts";
import { detectArtifactType } from "../production/mime-detector.ts";
import { generateNanoBananaImage } from "./nano-banana.server.ts";

/**
 * Live contract test for the Google image provider (P4c). It makes one real request and checks what came back: the bytes
 * must be a decodable image by their own magic number, and the reported size must be positive. It is skipped unless the
 * same credential the provider reads is configured, so no run can pass without a real response. A provider is "connected"
 * only after this test passes against the live service.
 */
const hasCredential = Boolean(ProviderConfigResolver.resolveGoogle().apiKey);

test("Google image provider: a live request returns a decodable image (credential-gated contract)", { skip: !hasCredential }, async () => {
  const result = await generateNanoBananaImage({
    prompt: "A plain white ceramic mug on a neutral grey background, product photo, centred.",
    promptVersion: "p4c-contract-v1",
    aspectRatio: "1:1",
  });

  assert.equal(result.status, "ready", result.status === "ready" ? "" : `provider returned ${result.status}: ${result.error}`);
  if (result.status !== "ready") return;

  const detected = detectArtifactType(result.bytes);
  assert.ok(["image/png", "image/jpeg", "image/webp"].includes(detected.mimeType), `live bytes are an image, got ${detected.mimeType}`);
  assert.ok(result.bytes.byteLength > 0, "the image has bytes");
  assert.ok(result.width > 0 && result.height > 0, "the image reports a positive size");
});
