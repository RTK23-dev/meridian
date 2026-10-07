import assert from "node:assert/strict";
import test from "node:test";
import { encryptPayload, decryptPayload } from "./crypto.ts";
import { storeVaultCredential, retrieveVaultCredential, deleteVaultCredential } from "./service.ts";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../learning/store.ts";

const TEST_SECRET = "test-master-encryption-key-with-sufficient-length-32";

test("Vault Crypto: encrypts and decrypts payload correctly with AES-256-GCM", () => {
  const payload = JSON.stringify({ accessToken: "secret-token-123", refreshToken: "refresh-456" });
  const envelope = encryptPayload(payload, TEST_SECRET);

  assert.ok(envelope.ciphertext);
  assert.ok(envelope.iv);
  assert.ok(envelope.tag);
  assert.equal(envelope.keyVersion, 1);

  const decrypted = decryptPayload(envelope, TEST_SECRET);
  assert.equal(decrypted, payload);
  const parsed = JSON.parse(decrypted);
  assert.equal(parsed.accessToken, "secret-token-123");
  assert.equal(parsed.refreshToken, "refresh-456");
});

test("Vault Crypto: tampering with ciphertext or auth tag fails decryption", () => {
  const payload = "sensitive-api-token";
  const envelope = encryptPayload(payload, TEST_SECRET);

  // Tamper with ciphertext
  const tamperedCipher = Buffer.from(envelope.ciphertext, "base64");
  tamperedCipher[0] = tamperedCipher[0] ^ 0xff; // flip bits
  const tamperedEnvelope = {
    ...envelope,
    ciphertext: tamperedCipher.toString("base64"),
  };

  assert.throws(() => {
    decryptPayload(tamperedEnvelope, TEST_SECRET);
  });

  // Tamper with wrong key
  assert.throws(() => {
    decryptPayload(envelope, "different-wrong-secret-key-00000000000000");
  });
});

test("Vault Service: stores and retrieves credentials with tenant isolation", async () => {
  const pg = new PGlite();
  await pg.waitReady;

  await pg.exec(`
    create table if not exists credential_vault (
      id text primary key,
      organization_id text not null,
      credential_type text not null,
      ciphertext text not null,
      iv text not null,
      tag text not null,
      key_version integer not null default 1,
      expires_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  const sql: Sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0];
    const params: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      query += `$${i + 1}` + strings[i + 1];
    }
    const res = await pg.query(query, params);
    return res.rows;
  }) as any;

  const orgA = "org_alpha";
  const orgB = "org_beta";

  // Store credential for Org A
  const stored = await storeVaultCredential(
    sql,
    orgA,
    "instagram_oauth",
    { accessToken: "ig-token-alpha", refreshToken: "ig-ref-alpha" },
    { masterKey: TEST_SECRET },
  );

  assert.ok(stored.id.startsWith("cred_"));

  // Retrieve as Org A
  const retrievedA = await retrieveVaultCredential(sql, orgA, stored.id, { masterKey: TEST_SECRET });
  assert.ok(retrievedA);
  assert.equal(retrievedA.accessToken, "ig-token-alpha");
  assert.equal(retrievedA.refreshToken, "ig-ref-alpha");

  // Attempt to retrieve as Org B (tenant boundary check)
  const retrievedB = await retrieveVaultCredential(sql, orgB, stored.id, { masterKey: TEST_SECRET });
  assert.equal(retrievedB, null);

  // Delete credential
  const deleted = await deleteVaultCredential(sql, orgA, stored.id);
  assert.equal(deleted, true);

  const afterDelete = await retrieveVaultCredential(sql, orgA, stored.id, { masterKey: TEST_SECRET });
  assert.equal(afterDelete, null);
});
