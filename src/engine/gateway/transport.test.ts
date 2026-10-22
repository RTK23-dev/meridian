import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { fetchInitFor, redirectRefusal } from "./transport.ts";

describe("transport: a redirect is refused, never followed", () => {
  it("sends every request with redirect set to error, so a key header never follows a 3xx", () => {
    const get = fetchInitFor({ method: "GET", url: "https://api.provider.test/v1/models", headers: { "x-api-key": "test-key" } });
    assert.equal(get.redirect, "error");
    const post = fetchInitFor({
      method: "POST",
      url: "https://api.provider.test/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(post.redirect, "error");
    assert.equal(post.body, "{}");
  });

  it("refuses a 302 as a non-retryable provider error that names the class of answer and carries no URL or key", () => {
    // Node's fetch rejects a 302 under redirect "error" with this shape (its cause is "unexpected redirect"). The redirect target is never requested.
    const refused = redirectRefusal(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }));
    assert.ok(refused instanceof EngineError);
    assert.equal(refused.kind, "provider");
    assert.equal(refused.retryable, false);
    assert.match(refused.message, /redirect \(3xx\)/);
    assert.doesNotMatch(refused.message, /https?:\/\/|key=/);
  });

  it("leaves every other failure as it was, so the classifier still sees a network reset, an abort or a plain error", () => {
    assert.equal(redirectRefusal(new TypeError("fetch failed", { cause: new Error("ECONNRESET") })), null);
    assert.equal(redirectRefusal(new DOMException("The operation was aborted", "AbortError")), null);
    assert.equal(redirectRefusal(new Error("unexpected redirect")), null);
  });
});
