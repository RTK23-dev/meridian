import assert from "node:assert/strict";
import test from "node:test";
import { generateNanoBananaImage, normalizeGoogleImageResponse } from "./nano-banana.server.ts";

function createValidPng(width = 512, height = 512): Uint8Array {
  const png = new Uint8Array(32);
  // PNG signature
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR chunk dimensions at offset 16 and 20
  new DataView(png.buffer).setUint32(16, width);
  new DataView(png.buffer).setUint32(20, height);
  return png;
}

test("normalizeGoogleImageResponse: parses official Google Interactions steps[].content[] block", () => {
  const validPng = createValidPng(512, 512);
  const base64 = Buffer.from(validPng).toString("base64");

  const rawDocumentedResponse = {
    id: "interactions/interaction-987",
    status: "completed",
    steps: [
      {
        id: "step-1",
        type: "model_output",
        content: [
          {
            type: "image",
            mime_type: "image/png",
            data: base64,
          },
        ],
      },
    ],
  };

  const normalized = normalizeGoogleImageResponse(rawDocumentedResponse);
  assert.ok(!("error" in normalized));
  assert.equal(normalized.mimeType, "image/png");
  assert.equal(normalized.dataBase64, base64);
});

test("normalizeGoogleImageResponse: parses URI file reference in content block", () => {
  const uriResponse = {
    id: "interactions/interaction-101",
    status: "completed",
    steps: [
      {
        content: [
          {
            type: "image",
            mime_type: "image/png",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/file-123",
          },
        ],
      },
    ],
  };

  const normalized = normalizeGoogleImageResponse(uriResponse);
  assert.ok(!("error" in normalized));
  assert.equal(normalized.uri, "https://generativelanguage.googleapis.com/v1beta/files/file-123");
});

test("normalizeGoogleImageResponse: returns typed error for empty, missing, or API error payloads", () => {
  assert.ok("error" in normalizeGoogleImageResponse(null));
  assert.ok("error" in normalizeGoogleImageResponse({}));
  assert.ok("error" in normalizeGoogleImageResponse({ steps: [{ content: [{ type: "text", text: "sorry" }] }] }));
  assert.ok("error" in normalizeGoogleImageResponse({ error: { message: "Quota exceeded" } }));
});

test("generateNanoBananaImage: successfully parses documented raw Interactions REST response", async () => {
  const validPng = createValidPng(720, 1280);
  const base64 = Buffer.from(validPng).toString("base64");

  const mockResponse = {
    id: "interactions/img-456",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          {
            type: "image",
            mime_type: "image/png",
            data: base64,
          },
        ],
      },
    ],
  };

  let capturedApiKey = "";
  let capturedModel = "";

  const result = await generateNanoBananaImage({
    prompt: "Vibrant skincare product bottle on marble surface",
    promptVersion: "v1.0",
    env: { MERIDIAN_GEMINI_API_KEY: "test-google-key-123" },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/interactions");
      capturedApiKey = new Headers(init?.headers).get("x-goog-api-key") || "";
      const body = JSON.parse(String(init?.body));
      capturedModel = body.model;
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    },
  });

  assert.equal(capturedApiKey, "test-google-key-123");
  assert.equal(capturedModel, "gemini-nano-banana-2.1");
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.provider, "google:nano-banana");
    assert.equal(result.width, 720);
    assert.equal(result.height, 1280);
    assert.equal(result.bytes.byteLength, 32);
    assert.ok(result.sha256.length === 64);
  }
});

test("generateNanoBananaImage: fails safely with typed error on malformed base64 or invalid dimensions", async () => {
  const invalidResult = await generateNanoBananaImage({
    prompt: "invalid image",
    promptVersion: "v1.0",
    env: { MERIDIAN_GEMINI_API_KEY: "test-key" },
    fetchImpl: async () => {
      return new Response(
        JSON.stringify({
          steps: [{ content: [{ type: "image", mime_type: "image/png", data: "not_a_valid_png" }] }],
        }),
        { status: 200 }
      );
    },
  });

  assert.equal(invalidResult.status, "failed");
  if (invalidResult.status === "failed") {
    assert.ok(invalidResult.error.length > 0);
  }
});
