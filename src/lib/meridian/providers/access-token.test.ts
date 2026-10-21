import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { sealSecret } from "../oauth/flow.server.ts";
import { encryptPayload } from "../vault/crypto.ts";
import { providerAccessToken, providerCredentialState } from "./access-token.ts";

const KEY = "access-token-test-key";

function withEncryptionKey<T>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    const prior = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    try {
      return await fn();
    } finally {
      if (prior === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = prior;
    }
  };
}

/** A saved workspace key row, as the credential vault stores it. */
function savedKeyRow(apiKey: string, expiresAt: string | null = null) {
  const envelope = encryptPayload(JSON.stringify({ apiKey }), KEY);
  return { id: "cred-saved", organization_id: "org-1", ciphertext: envelope.ciphertext, iv: envelope.iv, tag: envelope.tag, key_version: envelope.keyVersion, expires_at: expiresAt };
}

function fakeSql(vault: unknown[] = []): Sql {
  return (async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("from credential_vault")) return vault;
    return [];
  }) as unknown as Sql;
}

const base = { organizationId: "org-1", encryptionKey: KEY };

test("a sealed OAuth token is the token, and no environment token is read", withEncryptionKey(async () => {
  const sealed = sealSecret("oauth-tok", KEY) as string;
  const result = await providerAccessToken(fakeSql(), { ...base, provider: "meta", sealed, env: { META_ACCESS_TOKEN: "env-tok" } });
  assert.deepEqual(result, { token: "oauth-tok", source: "sealed" });
}));

test("a sealed token that cannot be opened is an error and does not fall through to a saved key", withEncryptionKey(async () => {
  const sealed = sealSecret("oauth-tok", "some-other-key") as string;
  const result = await providerAccessToken(fakeSql([savedKeyRow("saved-key-value")]), { ...base, provider: "meta", sealed, env: {} });
  assert.ok("error" in result);
  assert.equal("token" in result, false);
}));

test("with no sealed token, the workspace's saved key is used", withEncryptionKey(async () => {
  const result = await providerAccessToken(fakeSql([savedKeyRow("saved-key-value")]), { ...base, provider: "meta", sealed: "", env: {} });
  assert.deepEqual(result, { token: "saved-key-value", source: "workspace" });
}));

test("with no sealed token and no saved key, an environment token is not used without the deployment opt-in", withEncryptionKey(async () => {
  const result = await providerAccessToken(fakeSql(), { ...base, provider: "meta", sealed: "", env: { META_ACCESS_TOKEN: "env-tok" } });
  assert.ok("error" in result);
  assert.equal("token" in result, false);
  assert.match(result.error, /META_GRAPH_SHARED_DEFAULT=deployment/);
}));

test("the deployment key is used only when its shared-default variable is opted in", withEncryptionKey(async () => {
  const result = await providerAccessToken(fakeSql(), {
    ...base,
    provider: "meta",
    sealed: "",
    env: { META_GRAPH_SHARED_DEFAULT: "deployment", META_ACCESS_TOKEN: "dep-tok" },
  });
  assert.deepEqual(result, { token: "dep-tok", source: "deployment_shared_default" });
}));

/** A fake that records each query with its values, so a test can check the SQL text and what was bound to it. */
function recordingFake(vault: unknown[] = [], failOn = "") {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (failOn && text.includes(failOn)) throw new Error(`driver detail for ${KEY}`);
    if (text.includes("from credential_vault")) return vault;
    return [];
  }) as unknown as Sql;
  return { sql, calls };
}

const SEALED_VALUE = "sealed-token-test-value";
const SAVED_VALUE = "saved-key-test-value";

test("a sealed token that opens is usable, and the state carries no token", withEncryptionKey(async () => {
  const sealed = sealSecret(SEALED_VALUE, KEY) as string;
  const result = await providerCredentialState(fakeSql(), { ...base, provider: "meta", sealed, env: {} });
  assert.deepEqual(Object.keys(result).sort(), ["reason", "state"]);
  assert.equal(result.state, "usable");
  assert.equal(JSON.stringify(result).includes(SEALED_VALUE), false);
}));

test("a sealed token that cannot be opened is unusable, and the saved key is never read", withEncryptionKey(async () => {
  const sealed = sealSecret("oauth-tok", "some-other-key") as string;
  const db = recordingFake([savedKeyRow(SAVED_VALUE)]);
  const result = await providerCredentialState(db.sql, { ...base, provider: "meta", sealed, env: {} });
  assert.deepEqual(result, { state: "unusable", reason: "The stored token could not be read. Nothing was sent." });
  assert.equal(db.calls.some((call) => call.text.includes("credential_vault")), false);
}));

test("a sealed token with no encryption key is unusable, and nothing is opened", withEncryptionKey(async () => {
  const sealed = sealSecret("oauth-tok", KEY) as string;
  const result = await providerCredentialState(fakeSql(), { ...base, encryptionKey: "", provider: "meta", sealed, env: {} });
  assert.equal(result.state, "unusable");
  assert.match(result.reason, /TOKEN_ENCRYPTION_KEY is not configured/);
}));

test("with no sealed token, a ready saved key is usable, and every vault read is bound to the workspace", withEncryptionKey(async () => {
  const db = recordingFake([savedKeyRow(SAVED_VALUE)]);
  const result = await providerCredentialState(db.sql, { ...base, provider: "meta", sealed: "", env: {} });
  assert.deepEqual(result, { state: "usable", reason: "The workspace's saved credential can be used." });
  assert.equal(JSON.stringify(result).includes(SAVED_VALUE), false);
  const reads = db.calls.filter((call) => call.text.includes("from credential_vault"));
  assert.ok(reads.length > 0);
  for (const call of reads) {
    assert.match(call.text, /organization_id = \?/);
    assert.ok(call.values.includes("org-1"));
  }
}));

test("an expired saved key is unusable with its reason", withEncryptionKey(async () => {
  const expired = new Date(Date.now() - 60_000).toISOString();
  const result = await providerCredentialState(fakeSql([savedKeyRow(SAVED_VALUE, expired)]), { ...base, provider: "meta", sealed: "", env: {} });
  assert.equal(result.state, "unusable");
  assert.match(result.reason, /has expired/);
  assert.equal(JSON.stringify(result).includes(SAVED_VALUE), false);
}));

test("with no sealed token and no saved key, the state is not_configured with the resolver's reason", withEncryptionKey(async () => {
  const result = await providerCredentialState(fakeSql(), { ...base, provider: "meta", sealed: "", env: {} });
  assert.equal(result.state, "not_configured");
  assert.match(result.reason, /META_GRAPH_SHARED_DEFAULT=deployment/);
}));

test("Google has no saved-key category, so with no sealed token it is not_configured and nothing is queried", withEncryptionKey(async () => {
  const db = recordingFake([savedKeyRow(SAVED_VALUE)]);
  const result = await providerCredentialState(db.sql, {
    ...base,
    provider: "google",
    sealed: "",
    env: { META_GRAPH_SHARED_DEFAULT: "deployment", META_ACCESS_TOKEN: "dep-token" },
  });
  assert.deepEqual(result, { state: "not_configured", reason: "No access token is stored and none is configured. Nothing was sent." });
  assert.equal(db.calls.length, 0);
}));

test("a deployment key opted in for a workspace with no saved key is usable, and no key is in the state", withEncryptionKey(async () => {
  const result = await providerCredentialState(fakeSql(), {
    ...base,
    provider: "meta",
    sealed: "",
    env: { META_GRAPH_SHARED_DEFAULT: "deployment", META_ACCESS_TOKEN: "dep-token-test-value" },
  });
  assert.equal(result.state, "usable");
  assert.equal(JSON.stringify(result).includes("dep-token-test-value"), false);
}));

test("a thrown error is unusable with a fixed message and no detail from the error", withEncryptionKey(async () => {
  const db = recordingFake([], "from credential_vault");
  const result = await providerCredentialState(db.sql, { ...base, provider: "meta", sealed: "", env: {} });
  assert.deepEqual(result, { state: "unusable", reason: "The stored credential could not be checked. Nothing was sent." });
  assert.equal(JSON.stringify(result).includes("driver detail"), false);
  assert.equal(JSON.stringify(result).includes(KEY), false);
}));

test("Google has no saved-key category, so with no OAuth token there is no token and no environment read", withEncryptionKey(async () => {
  const result = await providerAccessToken(fakeSql([savedKeyRow("saved-key-value")]), {
    ...base,
    provider: "google",
    sealed: "",
    env: { GOOGLE_ADS_ACCESS_TOKEN: "env-google", META_GRAPH_SHARED_DEFAULT: "deployment", META_ACCESS_TOKEN: "dep" },
  });
  assert.ok("error" in result);
  assert.equal("token" in result, false);
}));
