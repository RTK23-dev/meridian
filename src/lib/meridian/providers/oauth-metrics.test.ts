// The credential state of a provider whose metrics are read per tenant (review 2026-10-22, item 5): the status and the metric sync must agree,
// so a saved key alone is not a usable connection for them. Pure: no database is read when the OAuth token is required and missing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { OAUTH_METRIC_PROVIDERS, providerCredentialState } from "./access-token.ts";
import type { Sql } from "../learning/store.ts";

// The check returns before any read, so the connection is never used: a stand-in that would throw if it were.
const noDatabase = (() => {
  throw new Error("no database read is expected");
}) as unknown as Sql;

test("a metric provider with only a saved key is unusable: the status says the OAuth connection is needed, and nothing is read", async () => {
  for (const provider of OAUTH_METRIC_PROVIDERS) {
    const state = await providerCredentialState(noDatabase, { organizationId: "org_a", provider, sealed: "", encryptionKey: "", requireOAuth: true });
    assert.equal(state.state, "unusable", provider);
    assert.match(state.reason, /OAuth connection/);
  }
});

test("a provider without the OAuth requirement keeps the saved-key rule: a provider with no category is not configured", async () => {
  const state = await providerCredentialState(noDatabase, { organizationId: "org_a", provider: "linkedin", sealed: "", encryptionKey: "" });
  assert.equal(state.state, "not_configured");
});

test("a stored access token past its stated expiry is unusable without a refresh token, and usable with one (review 2026-10-22, item 6)", async () => {
  // A token that opens: sealed with the same key the state reads it with, so the expiry is what decides.
  const { sealSecret } = await import("../oauth/flow.server.ts");
  const key = "k".repeat(32);
  const sealed = sealSecret("access-token-value", key);
  if (typeof sealed !== "string") throw new Error("the fixture token must seal");
  const past = "2020-01-01T00:00:00.000Z";
  const now = "2026-10-22T10:00:00.000Z";
  const expired = await providerCredentialState(noDatabase, { organizationId: "org_a", provider: "linkedin", sealed, encryptionKey: key, expiresAt: past, hasRefresh: false, now });
  assert.equal(expired.state, "unusable");
  assert.match(expired.reason, /expired/);
  const renewable = await providerCredentialState(noDatabase, { organizationId: "org_a", provider: "linkedin", sealed, encryptionKey: key, expiresAt: past, hasRefresh: true, now });
  assert.equal(renewable.state, "usable", "an expired token with a refresh token is renewed on use");
  const unstated = await providerCredentialState(noDatabase, { organizationId: "org_a", provider: "linkedin", sealed, encryptionKey: key, expiresAt: null, hasRefresh: false, now });
  assert.equal(unstated.state, "usable", "a token with no stated expiry is not treated as expired");
});
