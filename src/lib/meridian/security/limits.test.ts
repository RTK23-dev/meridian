import assert from "node:assert/strict";
import test from "node:test";
import { authLimit, clientKey, createRateLimit, inviteLimit, modelLimit, refuseIfLimited, RATE_LIMIT_MESSAGE, uploadLimit } from "./limits.ts";

test("a limiter refuses the next call after the window fills", () => {
  const limiter = createRateLimit(2, 60_000);
  assert.equal(limiter.allow("user-1", 1_000), true);
  assert.equal(limiter.allow("user-1", 1_001), true);
  assert.equal(limiter.allow("user-1", 1_002), false);
  assert.equal(limiter.allow("user-2", 1_002), true);
  assert.throws(() => refuseIfLimited(limiter, "user-1", 1_003), (error: Error) => error.message === RATE_LIMIT_MESSAGE);
});

test("sign-in, invite, upload, and model limiters are distinct named budgets", () => {
  assert.equal(authLimit.allow("ip-1", 10), true);
  assert.equal(inviteLimit.allow("user-1", 10), true);
  assert.equal(uploadLimit.allow("user-1", 10), true);
  assert.equal(modelLimit.allow("user-1", 10), true);
});

test("auth keys ignore client-supplied forwarding headers unless a trusted proxy is configured", () => {
  const request = new Request("https://example.test/api/auth/sign-in", {
    headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.1", "x-real-ip": "198.51.100.4" },
  });
  const previous = process.env.MERIDIAN_TRUST_PROXY_HEADERS;
  delete process.env.MERIDIAN_TRUST_PROXY_HEADERS;
  assert.equal(clientKey(request), "untrusted-client");
  process.env.MERIDIAN_TRUST_PROXY_HEADERS = "true";
  assert.equal(clientKey(request), "203.0.113.8");
  if (previous === undefined) delete process.env.MERIDIAN_TRUST_PROXY_HEADERS;
  else process.env.MERIDIAN_TRUST_PROXY_HEADERS = previous;
});
