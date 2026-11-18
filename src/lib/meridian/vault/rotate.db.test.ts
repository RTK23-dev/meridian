// Key rotation on a real Postgres (PGlite, or MERIDIAN_PG_TEST_URL). Values are seeded with the app's own sealing functions.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { openSecret, sealSecret } from "../oauth/flow.server.ts";
import { sealSessionUri } from "../storage/session-seal.ts";
import { decryptPayloadWithKeys, encryptPayload, openCompactWithKeys } from "./crypto.ts";
import { formatRotationReport, rotateEncryptedColumns, type ColumnCount } from "./rotate.ts";
import { storeVaultCredential } from "./service.ts";
import { sealedSessionEnvelope } from "../storage/session-seal.ts";

const OLD = "old-key-for-rotation-db-test-00000001";
const NEW = "new-key-for-rotation-db-test-00000002";
const LOST = "a-key-nobody-has-any-more-0000000003";
const KEYS = { current: NEW, previous: OLD };
const ORG = "org_rotate";

let db: TestDatabase;
const vaultPlain = new Map<string, string>();
const tokenPlain = new Map<string, { token: string; refresh: string }>();
const sessionPlain = new Map<string, string>();

type Snapshot = Record<string, unknown>[];

async function snapshot(): Promise<Snapshot> {
  return [
    ...(await db.sql.query("select id, ciphertext, iv, tag, key_version from credential_vault order by id")),
    ...(await db.sql.query("select id, sealed_token, sealed_refresh, expires_at from provider_secrets order by id")),
    ...(await db.sql.query("select id, session_uri from artifact_upload_sessions order by id")),
  ];
}

function byColumn(counts: ColumnCount[]): Record<string, Omit<ColumnCount, "column">> {
  return Object.fromEntries(counts.map(({ column, ...rest }) => [column, rest]));
}

async function insertSession(id: string, sessionUri: string): Promise<void> {
  await db.sql`
    insert into artifact_upload_sessions (id, organization_id, brand_id, storage_key, mime_type, total_bytes, sha256, session_uri)
    values (${id}, ${ORG}, ${"brand_rotate"}, ${`key/${id}`}, 'video/mp4', 10, ${"a".repeat(64)}, ${sessionUri})
  `;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, "brand_rotate");
  // Vault: three under the old key, one already under the new key, one under a lost key.
  for (const [index, key] of [OLD, OLD, OLD, NEW].entries()) {
    const plain = { accessToken: `vault-token-${index}`, apiKey: `api-${index}` };
    const { id } = await storeVaultCredential(db.sql, ORG, `type_${index}`, plain, { masterKey: key });
    vaultPlain.set(id, JSON.stringify(plain));
  }
  const lost = encryptPayload("{}", LOST);
  await db.sql`
    insert into credential_vault (id, organization_id, credential_type, ciphertext, iv, tag)
    values ('cred_lost', ${ORG}, 'type_lost', ${lost.ciphertext}, ${lost.iv}, ${lost.tag})
  `;
  // OAuth tokens: old with refresh, old without refresh, new, old token with a lost refresh.
  const tokens: [string, string, string, string][] = [
    ["ps_a", OLD, "access-a", "refresh-a"],
    ["ps_b", OLD, "access-b", ""],
    ["ps_c", NEW, "access-c", "refresh-c"],
  ];
  for (const [id, key, token, refresh] of tokens) {
    await db.sql`
      insert into provider_secrets (id, organization_id, provider, sealed_token, sealed_refresh)
      values (${id}, ${ORG}, ${`p_${id}`}, ${sealSecret(token, key) as string}, ${refresh ? (sealSecret(refresh, key) as string) : ""})
    `;
    tokenPlain.set(id, { token, refresh });
  }
  await db.sql`
    insert into provider_secrets (id, organization_id, provider, sealed_token, sealed_refresh)
    values ('ps_lost', ${ORG}, 'p_lost', ${sealSecret("access-d", OLD) as string}, ${sealSecret("refresh-d", LOST) as string})
  `;
  tokenPlain.set("ps_lost", { token: "access-d", refresh: "" });
  // Upload sessions: two old, one new, one empty (no session yet), one under a lost key.
  for (const [id, key] of [["us_a", OLD], ["us_b", OLD], ["us_c", NEW]] as const) {
    const uri = `https://upload.example/${id}`;
    await insertSession(id, sealSessionUri(uri, key));
    sessionPlain.set(id, uri);
  }
  await insertSession("us_empty", "");
  await insertSession("us_lost", sealSessionUri("https://upload.example/lost", LOST));
});

after(async () => {
  await db.close();
});

const EXPECTED_BEFORE = {
  "credential_vault.ciphertext": { reencryptable: 3, current: 1, unreadable: 1, reencrypted: 0 },
  "provider_secrets.sealed_token": { reencryptable: 3, current: 1, unreadable: 0, reencrypted: 0 },
  "provider_secrets.sealed_refresh": { reencryptable: 1, current: 1, unreadable: 1, reencrypted: 0 },
  "artifact_upload_sessions.session_uri": { reencryptable: 2, current: 1, unreadable: 1, reencrypted: 0 },
};

describe("npm run keys:rotate on a seeded database", () => {
  let lostRows: Snapshot;

  it("a dry run counts every column and changes nothing", async (t) => {
    const before = await snapshot();
    const counts = await rotateEncryptedColumns(db.sql, KEYS, { dryRun: true, batchSize: 2 });
    for (const line of formatRotationReport(counts, true)) t.diagnostic(line);
    assert.deepEqual(byColumn(counts), EXPECTED_BEFORE);
    assert.deepEqual(await snapshot(), before);
    lostRows = before.filter((row) => ["cred_lost", "ps_lost", "us_lost"].includes(row.id as string));
  });

  it("the rotation re-encrypts every readable value under the current key, in batches", async (t) => {
    const counts = await rotateEncryptedColumns(db.sql, KEYS, { batchSize: 2 });
    for (const line of formatRotationReport(counts, false)) t.diagnostic(line);
    assert.deepEqual(byColumn(counts), {
      "credential_vault.ciphertext": { ...EXPECTED_BEFORE["credential_vault.ciphertext"], reencrypted: 3 },
      "provider_secrets.sealed_token": { ...EXPECTED_BEFORE["provider_secrets.sealed_token"], reencrypted: 3 },
      "provider_secrets.sealed_refresh": { ...EXPECTED_BEFORE["provider_secrets.sealed_refresh"], reencrypted: 1 },
      "artifact_upload_sessions.session_uri": { ...EXPECTED_BEFORE["artifact_upload_sessions.session_uri"], reencrypted: 2 },
    });
  });

  it("every readable value now opens with the current key alone, to the same plaintext", async () => {
    const vault = await db.sql.query<{ id: string; ciphertext: string; iv: string; tag: string }>(
      "select id, ciphertext, iv, tag from credential_vault where id <> 'cred_lost'",
    );
    assert.equal(vault.length, vaultPlain.size);
    for (const row of vault) assert.equal(decryptPayloadWithKeys(row, [NEW]).plaintext, vaultPlain.get(row.id));

    const secrets = await db.sql.query<{ id: string; sealed_token: string; sealed_refresh: string }>(
      "select id, sealed_token, sealed_refresh from provider_secrets",
    );
    for (const row of secrets) {
      const expected = tokenPlain.get(row.id);
      assert.equal(openCompactWithKeys(row.sealed_token, [NEW]).plaintext, expected?.token);
      assert.equal(openSecret(row.sealed_token, NEW), expected?.token);
      if (row.id === "ps_lost") continue;
      if (expected?.refresh) assert.equal(openCompactWithKeys(row.sealed_refresh, [NEW]).plaintext, expected.refresh);
      else assert.equal(row.sealed_refresh, "");
    }

    const sessions = await db.sql.query<{ id: string; session_uri: string }>(
      "select id, session_uri from artifact_upload_sessions where id in ('us_a', 'us_b', 'us_c')",
    );
    for (const row of sessions) {
      const envelope = sealedSessionEnvelope(row.session_uri);
      assert.ok(envelope);
      assert.equal(decryptPayloadWithKeys(envelope, [NEW]).plaintext, sessionPlain.get(row.id));
    }
    const [empty] = await db.sql.query<{ session_uri: string }>("select session_uri from artifact_upload_sessions where id = 'us_empty'");
    assert.equal(empty?.session_uri, "");
  });

  it("values neither key opens are left exactly as they were", async () => {
    const now = (await snapshot()).filter((row) => ["cred_lost", "us_lost"].includes(row.id as string));
    assert.deepEqual(now, lostRows.filter((row) => row.id !== "ps_lost"));
    const [psLost] = await db.sql.query<{ sealed_refresh: string }>("select sealed_refresh from provider_secrets where id = 'ps_lost'");
    assert.equal(psLost?.sealed_refresh, lostRows.find((row) => row.id === "ps_lost")?.sealed_refresh, "the lost refresh is untouched");
    assert.throws(() => openCompactWithKeys(psLost?.sealed_refresh ?? "", [NEW, OLD]));
  });

  it("a second run changes nothing", async () => {
    const before = await snapshot();
    const counts = await rotateEncryptedColumns(db.sql, KEYS, { batchSize: 2 });
    assert.deepEqual(byColumn(counts), {
      "credential_vault.ciphertext": { reencryptable: 0, current: 4, unreadable: 1, reencrypted: 0 },
      "provider_secrets.sealed_token": { reencryptable: 0, current: 4, unreadable: 0, reencrypted: 0 },
      "provider_secrets.sealed_refresh": { reencryptable: 0, current: 2, unreadable: 1, reencrypted: 0 },
      "artifact_upload_sessions.session_uri": { reencryptable: 0, current: 3, unreadable: 1, reencrypted: 0 },
    });
    assert.deepEqual(await snapshot(), before);
  });

  it("the report has counts only, never a value or a key", async () => {
    const counts = await rotateEncryptedColumns(db.sql, KEYS, { dryRun: true });
    const text = [...formatRotationReport(counts, true), ...formatRotationReport(counts, false)].join("\n");
    for (const secret of [OLD, NEW, "access-a", "refresh-a", "vault-token-0", "https://upload.example"]) {
      assert.ok(!text.includes(secret));
    }
    assert.ok(!/[A-Za-z0-9+/]{24,}/.test(text), "no base64 ciphertext in the report");
  });
});
