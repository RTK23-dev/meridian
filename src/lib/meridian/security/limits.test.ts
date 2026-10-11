import assert from "node:assert/strict";
import test from "node:test";
import { attemptedAccount, authAttemptKey, authLimit, clientKey, createRateLimit, inviteLimit, modelLimit, refuseIfLimited, RATE_LIMIT_MESSAGE, uploadLimit } from "./limits.ts";

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

function setTrustProxy(value: string | undefined): () => void {
  const previous = process.env.MERIDIAN_TRUST_PROXY_HEADERS;
  if (value === undefined) delete process.env.MERIDIAN_TRUST_PROXY_HEADERS;
  else process.env.MERIDIAN_TRUST_PROXY_HEADERS = value;
  return () => {
    if (previous === undefined) delete process.env.MERIDIAN_TRUST_PROXY_HEADERS;
    else process.env.MERIDIAN_TRUST_PROXY_HEADERS = previous;
  };
}

function signIn(email: string, extraHeaders: Record<string, string> = {}, path = "/api/auth/sign-in/email"): Request {
  const body = JSON.stringify({ email, password: "wrong-password" });
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(body).byteLength), ...extraHeaders },
    body,
  });
}

/** One auth attempt through the same key path the auth route uses. */
async function attempt(limiter: { allow: (key: string, now: number) => boolean }, request: Request): Promise<boolean> {
  return limiter.allow(authAttemptKey(request, await attemptedAccount(request)), 1_000);
}

test("the attempted account comes only from a small JSON credential body", async () => {
  assert.equal(await attemptedAccount(signIn("  Victim@Example.test ")), "victim@example.test");
  assert.equal(await attemptedAccount(new Request("https://example.test/api/auth/sign-in/email")), undefined, "GET has no account");
  assert.equal(await attemptedAccount(signIn("a@example.test", { "content-length": "99999" })), undefined, "oversized body is not read");
  const plain = new Request("https://example.test/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "text/plain", "content-length": "21" },
    body: "email=a@example.test",
  });
  assert.equal(await attemptedAccount(plain), undefined, "non-JSON body is not read");
  const malformed = new Request("https://example.test/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "9" },
    body: "{not json",
  });
  assert.equal(await attemptedAccount(malformed), undefined, "malformed JSON never throws");
});

test("untrusted clients: one attacker's exhausted bucket does not block another account", async () => {
  const restore = setTrustProxy(undefined);
  try {
    const limiter = createRateLimit(20, 60_000);
    for (let i = 0; i < 20; i += 1) assert.equal(await attempt(limiter, signIn("victim@example.test")), true);
    assert.equal(await attempt(limiter, signIn("victim@example.test")), false, "guessing against the targeted account is capped");
    assert.equal(await attempt(limiter, signIn("someone-else@example.test")), true, "a different account stays usable");
  } finally {
    restore();
  }
});

test("untrusted clients: rotating forwarding headers does not reset the guessing budget for one account", async () => {
  const restore = setTrustProxy(undefined);
  try {
    const limiter = createRateLimit(20, 60_000);
    for (let i = 0; i < 20; i += 1) {
      const spoofed = signIn("victim@example.test", { "x-forwarded-for": `198.51.100.${i}`, "x-real-ip": `192.0.2.${i}` });
      assert.equal(await attempt(limiter, spoofed), true);
    }
    const next = signIn("victim@example.test", { "x-forwarded-for": "203.0.113.200" });
    assert.equal(await attempt(limiter, next), false, "brute force is still capped without a trusted proxy");
  } finally {
    restore();
  }
});

test("untrusted clients: a flood on one route without an account does not lock out other routes", async () => {
  const restore = setTrustProxy(undefined);
  try {
    const limiter = createRateLimit(20, 60_000);
    const socialStart = () => new Request("https://example.test/api/auth/sign-in/social", { method: "POST" });
    for (let i = 0; i < 20; i += 1) assert.equal(await attempt(limiter, socialStart()), true);
    assert.equal(await attempt(limiter, socialStart()), false, "the social-start route is throttled");
    assert.equal(await attempt(limiter, signIn("victim@example.test")), true, "email sign-in is not blocked by the social flood");
    const callback = new Request("https://example.test/api/auth/callback/google?code=abc&state=def");
    assert.equal(await attempt(limiter, callback), true, "OAuth callbacks are not blocked by the social flood");
  } finally {
    restore();
  }
});

test("with a trusted proxy, each client address has its own bucket on each route", async () => {
  const restore = setTrustProxy("true");
  try {
    const limiter = createRateLimit(20, 60_000);
    for (let i = 0; i < 20; i += 1) {
      assert.equal(await attempt(limiter, signIn("victim@example.test", { "x-forwarded-for": "203.0.113.8" })), true);
    }
    assert.equal(await attempt(limiter, signIn("victim@example.test", { "x-forwarded-for": "203.0.113.8" })), false);
    assert.equal(await attempt(limiter, signIn("victim@example.test", { "x-forwarded-for": "203.0.113.9" })), true, "another client address is not blocked");
  } finally {
    restore();
  }
});
