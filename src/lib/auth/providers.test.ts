import assert from "node:assert/strict";
import test from "node:test";
import { GROK_PROVIDERS, isBrokerUnreachableHost } from "./providers.ts";

test("X is not offered: the only federated provider is Google", () => {
  assert.deepEqual(
    GROK_PROVIDERS.map((provider) => provider.providerId),
    ["grok-google"],
  );
});

test("loopback hosts are unreachable for the broker; the sandbox and deployed hosts are not", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "::1"]) {
    assert.equal(isBrokerUnreachableHost(host), true, host);
  }
  assert.equal(isBrokerUnreachableHost("abc123.grok-sandbox.com"), false);
  assert.equal(isBrokerUnreachableHost("meridian.example.com"), false);
});
