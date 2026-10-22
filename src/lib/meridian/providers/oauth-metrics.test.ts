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
