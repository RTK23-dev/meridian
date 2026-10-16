import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { classifyError, providerErrorForFailedJob, providerErrorForStatus, ProviderCallError } from "./classify.ts";

describe("status codes", () => {
  it("maps rate limits, timeouts and server errors to retryable kinds", () => {
    assert.deepEqual(providerErrorForStatus(429, "slow down").kind, "rate_limit");
    assert.equal(providerErrorForStatus(429, "").retryable, true);
    assert.equal(providerErrorForStatus(408, "").kind, "timeout");
    assert.equal(providerErrorForStatus(503, "unavailable").kind, "server");
    assert.equal(providerErrorForStatus(503, "unavailable").retryable, true);
  });

  it("maps a 400 to invalid_input, and to content_policy when the body names a refusal", () => {
    const invalid = providerErrorForStatus(400, '{"error":"Unsupported value for resolution"}');
    assert.equal(invalid.kind, "invalid_input");
    assert.equal(invalid.retryable, false);
    const refused = providerErrorForStatus(400, '{"error":"Refused by content moderation policy"}');
    assert.equal(refused.kind, "content_policy");
    assert.equal(refused.retryable, false);
  });

  it("maps credential and other client errors to unknown, not retried", () => {
    const refused = providerErrorForStatus(403, "forbidden");
    assert.equal(refused.kind, "unknown");
    assert.equal(refused.retryable, false);
  });

  it("keeps the message short and single-line", () => {
    const long = `line one\n${"x".repeat(1000)}`;
    const error = providerErrorForStatus(500, long);
    assert.ok(error.message.length < 400);
    assert.doesNotMatch(error.message, /\n/);
  });
});

describe("failed jobs", () => {
  it("reclassifies a policy-like failure as content_policy and leaves the rest unknown", () => {
    const policy = providerErrorForFailedJob({ kind: "unknown", retryable: false, message: "refused by safety filter" });
    assert.equal(policy.kind, "content_policy");
    const other = providerErrorForFailedJob({ kind: "unknown", retryable: false, message: "the model ran out of frames" });
    assert.equal(other.kind, "unknown");
  });
});

describe("thrown errors", () => {
  it("keeps a ProviderCallError's classification", () => {
    const error = new ProviderCallError({ kind: "rate_limit", retryable: true, message: "429" });
    assert.deepEqual(classifyError(error), { kind: "rate_limit", retryable: true, message: "429" });
  });

  it("maps engine errors: invalid input stops, a retryable provider error is a server error, config is unknown", () => {
    assert.equal(classifyError(new EngineError("invalid_input", "bad duration")).kind, "invalid_input");
    const retryable = classifyError(new EngineError("provider", "answered 502", { retryable: true }));
    assert.equal(retryable.kind, "server");
    assert.equal(retryable.retryable, true);
    const config = classifyError(new EngineError("config", "not connected"));
    assert.equal(config.kind, "unknown");
    assert.equal(config.retryable, false);
  });

  it("maps a timeout or abort to timeout, and a network failure to a retryable server error", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    assert.equal(classifyError(timeout).kind, "timeout");
    const network = new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    const mapped = classifyError(network);
    assert.equal(mapped.kind, "server");
    assert.equal(mapped.retryable, true);
  });

  it("treats an unrecognised error as unknown and not retried", () => {
    const mapped = classifyError(new Error("something else"));
    assert.equal(mapped.kind, "unknown");
    assert.equal(mapped.retryable, false);
  });
});
