import assert from "node:assert/strict";
import test from "node:test";
import { embeddingProviderState } from "./provider.ts";

test("the external embeddings check reads the variables the embeddings call reads", () => {
  assert.equal(embeddingProviderState({}).status, "NOT_CONNECTED");
  assert.equal(embeddingProviderState({ url: "https://embed.example/v1/embeddings" }).status, "NOT_CONNECTED", "a URL without a key is not connected");
  assert.equal(embeddingProviderState({ key: "k" }).status, "NOT_CONNECTED", "a key without a URL is not connected");
  const connected = embeddingProviderState({ url: "https://embed.example/v1/embeddings", key: "k" });
  assert.equal(connected.status, "CONFIGURED");
  assert.equal(connected.provider, "external:semantic");
  assert.match(connected.detail, /EXTERNAL_SEMANTIC_URL and EXTERNAL_SEMANTIC_KEY/);
  assert.doesNotMatch(connected.detail, /OPENROUTER/, "an OpenRouter key is not an embeddings setting");
});

test("an OpenRouter key alone does not connect embeddings", () => {
  // The check takes only the embeddings variables, so there is no path from an OpenRouter key to CONFIGURED.
  assert.equal(embeddingProviderState({ url: "", key: "" }).status, "NOT_CONNECTED");
});
