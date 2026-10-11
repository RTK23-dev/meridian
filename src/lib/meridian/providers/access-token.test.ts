import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { sealSecret } from "../oauth/flow.server.ts";
import { encryptPayload } from "../vault/crypto.ts";
import { providerAccessToken } from "./access-token.ts";

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
function savedKeyRow(apiKey: string) {
  const envelope = encryptPayload(JSON.stringify({ apiKey }), KEY);
  return { id: "cred-saved", organization_id: "org-1", ciphertext: envelope.ciphertext, iv: envelope.iv, tag: envelope.tag, key_version: envelope.keyVersion, expires_at: null };
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
