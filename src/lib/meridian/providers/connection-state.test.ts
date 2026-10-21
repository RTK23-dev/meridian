import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CredentialEnv } from "../credentials/resolve.ts";
import type { Sql } from "../learning/store.ts";
import { sealSecret } from "../oauth/flow.server.ts";
import { encryptPayload } from "../vault/crypto.ts";
import { providerCredentialState, type ProviderCredentialState } from "./access-token.ts";
import { phaseForProbe, phaseForStoredConnection, type LiveProvider } from "./live.ts";

const KEY = "connection-state-test-key";
const SEALED_VALUE = "sealed-token-test-value";
const SAVED_VALUE = "saved-key-test-value";
const ENV_VALUE = "env-token-test-value";
const SUCCESS_AT = "2026-10-20T10:00:00.000Z";

const USABLE: ProviderCredentialState = { state: "usable", reason: "The stored access token can be opened." };
const NOT_CONFIGURED: ProviderCredentialState = {
  state: "not_configured",
  reason: "No access token is stored and none is configured. Nothing was sent.",
};
const EXPIRED: ProviderCredentialState = {
  state: "unusable",
  reason: "The workspace's saved Meta credential has expired. Save a new key in the settings.",
};

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

/** A fake database for the three tables a connection reads. It records each query with the values bound to it. */
function workspaceDb(options: { secrets?: unknown[]; connections?: unknown[]; vault?: unknown[] } = {}) {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (text.includes("from provider_secrets")) return options.secrets ?? [];
    if (text.includes("from provider_connections")) return options.connections ?? [];
    if (text.includes("from credential_vault")) return options.vault ?? [];
    return [];
  }) as unknown as Sql;
  return { sql, calls };
}

/**
 * The status one stored connection reads. It composes the same steps system.ts takes: the stored row, the sealed token of the
 * workspace, the credential state, and the phase. The environment is passed in, so a test never depends on the machine it runs on.
 */
async function statusFor(
  db: ReturnType<typeof workspaceDb>,
  organizationId: string,
  provider: LiveProvider,
  env: CredentialEnv = {},
) {
  const rows = await db.sql<{ provider: string; last_success_at: unknown; last_error: string; disconnected_at: unknown }>`
    select provider, last_success_at, last_error, disconnected_at from provider_connections where organization_id = ${organizationId}
  `;
  const secrets = await db.sql<{ provider: string; sealed_token: string }>`
    select provider, sealed_token from provider_secrets where organization_id = ${organizationId}
  `;
  const sealed = secrets.find((item) => item.provider === provider)?.sealed_token ?? "";
  const credential = await providerCredentialState(db.sql, {
    organizationId,
    provider,
    sealed,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY ?? "",
    env,
  });
  const row = rows.find((item) => item.provider === provider);
  return phaseForStoredConnection({
    provider,
    credential,
    lastSuccessAt: row?.last_success_at,
    lastError: row?.last_error ?? "",
    disconnected: Boolean(row?.disconnected_at),
  });
}

test("a recorded success with a usable credential is HEALTHY", () => {
  const phase = phaseForStoredConnection({ provider: "meta", credential: USABLE, lastSuccessAt: SUCCESS_AT, lastError: "", disconnected: false });
  assert.equal(phase.phase, "HEALTHY");
});

test("no credential is NOT_CONFIGURED with the credentials detail, even after an earlier success", () => {
  const phase = phaseForStoredConnection({ provider: "meta", credential: NOT_CONFIGURED, lastSuccessAt: SUCCESS_AT, lastError: "", disconnected: false });
  assert.equal(phase.phase, "NOT_CONFIGURED");
  assert.match(phase.detail, /^No credentials are configured/);
});

test("an expired saved key after an earlier success is FAILED with its reason, never HEALTHY", () => {
  const phase = phaseForStoredConnection({ provider: "meta", credential: EXPIRED, lastSuccessAt: SUCCESS_AT, lastError: "", disconnected: false });
  assert.equal(phase.phase, "FAILED");
  assert.equal(phase.detail, EXPIRED.reason);
});

test("an unusable credential is FAILED with its reason even when no provider error was recorded", () => {
  const phase = phaseForStoredConnection({ provider: "meta", credential: EXPIRED, lastSuccessAt: null, lastError: "", disconnected: false });
  assert.equal(phase.phase, "FAILED");
  assert.equal(phase.detail, EXPIRED.reason);
});

test("a disconnected connection is DISCONNECTED, whether its credential is usable, unusable or missing", () => {
  for (const credential of [USABLE, EXPIRED, NOT_CONFIGURED]) {
    const phase = phaseForStoredConnection({ provider: "meta", credential, lastSuccessAt: SUCCESS_AT, lastError: "", disconnected: true });
    assert.equal(phase.phase, "DISCONNECTED");
  }
});

test("a usable credential with a recorded provider error is FAILED with that error", () => {
  const phase = phaseForStoredConnection({
    provider: "tiktok",
    credential: USABLE,
    lastSuccessAt: null,
    lastError: "The provider rejected the token.",
    disconnected: false,
  });
  assert.equal(phase.phase, "FAILED");
  assert.equal(phase.detail, "The provider rejected the token.");
});

test("a usable credential with no recorded provider result is not HEALTHY", () => {
  const phase = phaseForStoredConnection({ provider: "meta", credential: USABLE, lastSuccessAt: null, lastError: "", disconnected: false });
  assert.notEqual(phase.phase, "HEALTHY");
});

test("phaseForProbe has no default for configured, so a call without it does not typecheck", () => {
  // @ts-expect-error configured is required. A call that omits it must not compile, and it reads as not configured when run.
  const withoutConfigured = phaseForProbe({ provider: "meta", ok: true, error: "", disconnected: false });
  assert.equal(withoutConfigured.phase, "NOT_CONFIGURED");
  assert.equal(phaseForProbe({ provider: "meta", ok: true, error: "", disconnected: false, configured: true }).phase, "HEALTHY");
});

test("a usable saved key with a recorded success is HEALTHY through the stored-connection path", withEncryptionKey(async () => {
  const db = workspaceDb({
    connections: [{ provider: "tiktok", last_success_at: SUCCESS_AT, last_error: "", disconnected_at: null }],
    vault: [savedKeyRow(SAVED_VALUE)],
  });
  const phase = await statusFor(db, "org-1", "tiktok");
  assert.equal(phase.phase, "HEALTHY");
}));

test("no stored credential and no shared default is NOT_CONFIGURED with the credentials detail", withEncryptionKey(async () => {
  const phase = await statusFor(workspaceDb(), "org-1", "meta");
  assert.equal(phase.phase, "NOT_CONFIGURED");
  assert.match(phase.detail, /^No credentials are configured/);
}));

test("an unopenable sealed token is FAILED after an earlier success, and the saved key is never read", withEncryptionKey(async () => {
  const sealed = sealSecret("oauth-token-test-value", "another-key") as string;
  const db = workspaceDb({
    secrets: [{ provider: "meta", sealed_token: sealed }],
    connections: [{ provider: "meta", last_success_at: SUCCESS_AT, last_error: "", disconnected_at: null }],
    vault: [savedKeyRow(SAVED_VALUE)],
  });
  const phase = await statusFor(db, "org-1", "meta");
  assert.equal(phase.phase, "FAILED");
  assert.equal(phase.detail, "The stored token could not be read. Nothing was sent.");
  assert.equal(db.calls.some((call) => call.text.includes("credential_vault")), false);
}));

test("an unreadable saved key after an earlier success is FAILED with its reason, never HEALTHY", withEncryptionKey(async () => {
  const unreadable = { ...savedKeyRow(SAVED_VALUE), ciphertext: "not-a-ciphertext", tag: "not-a-tag" };
  const db = workspaceDb({
    connections: [{ provider: "tiktok", last_success_at: SUCCESS_AT, last_error: "", disconnected_at: null }],
    vault: [unreadable],
  });
  const phase = await statusFor(db, "org-1", "tiktok");
  assert.equal(phase.phase, "FAILED");
  assert.notEqual(phase.phase, "HEALTHY");
  assert.match(phase.detail, /could not be read/);
}));

test("every provider_secrets, provider_connections and credential_vault read is bound to the workspace", withEncryptionKey(async () => {
  const sealed = sealSecret(SEALED_VALUE, KEY) as string;
  const db = workspaceDb({
    secrets: [{ provider: "meta", sealed_token: sealed }],
    connections: [{ provider: "meta", last_success_at: SUCCESS_AT, last_error: "", disconnected_at: null }],
    vault: [savedKeyRow(SAVED_VALUE)],
  });
  await statusFor(db, "org-1", "meta");
  await statusFor(db, "org-1", "tiktok");
  const reads = db.calls.filter((call) => /provider_secrets|provider_connections|credential_vault/.test(call.text));
  assert.ok(reads.length >= 4);
  for (const call of reads) {
    assert.match(call.text, /organization_id = \?/);
    assert.ok(call.values.includes("org-1"), `a read was not bound to the workspace: ${call.text}`);
  }
}));

test("the statuses and states carry no key value, even when every source holds one", withEncryptionKey(async () => {
  const sealed = sealSecret(SEALED_VALUE, KEY) as string;
  const db = workspaceDb({
    secrets: [{ provider: "meta", sealed_token: sealed }],
    connections: [
      { provider: "meta", last_success_at: SUCCESS_AT, last_error: "", disconnected_at: null },
      { provider: "tiktok", last_success_at: null, last_error: "", disconnected_at: null },
    ],
    vault: [savedKeyRow(SAVED_VALUE)],
  });
  const outputs = [
    await statusFor(db, "org-1", "meta", { META_ACCESS_TOKEN: ENV_VALUE }),
    await statusFor(db, "org-1", "tiktok", { TIKTOK_ACCESS_TOKEN: ENV_VALUE }),
    await providerCredentialState(db.sql, { organizationId: "org-1", provider: "tiktok", sealed: "", encryptionKey: KEY, env: {} }),
  ];
  const serialized = JSON.stringify(outputs);
  for (const value of [SEALED_VALUE, SAVED_VALUE, ENV_VALUE, KEY]) {
    assert.equal(serialized.includes(value), false);
  }
}));

test("the connection code filters every provider_secrets and provider_connections statement by organization_id", () => {
  const files = ["../system.ts", "../performance/actions.ts", "./connect.ts", "./access-token.ts"];
  let statements = 0;
  for (const file of files) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    for (const match of source.matchAll(/\b(from|into|update)\s+(provider_secrets|provider_connections)\b/g)) {
      statements += 1;
      const start = match.index ?? 0;
      const statement = source.slice(start, source.indexOf("`", start));
      if (match[1] === "into") {
        assert.match(statement, /\(\s*id\s*,\s*organization_id\s*,/, `${file}: an insert into ${match[2]} must name organization_id`);
      } else {
        assert.match(statement, /where\s+organization_id\s*=\s*\$\{/, `${file}: ${match[1]} ${match[2]} must filter by organization_id`);
      }
    }
  }
  // Ten statements exist in these files today. The floor keeps the scan from passing because it found nothing.
  assert.ok(statements >= 10, `the scan found ${statements} statements, expected at least 10`);
});
