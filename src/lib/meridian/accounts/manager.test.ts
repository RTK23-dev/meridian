import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../learning/store.ts";
import {
  listBrandPlatformAccounts,
  connectPlatformAccount,
  disconnectPlatformAccount,
  getAccountDecryptedCredential,
} from "./manager.ts";

const TEST_SECRET = "test-master-encryption-key-with-sufficient-length-32";

test("Platform Account Manager: connects multiple accounts per platform and retrieves credentials", async () => {
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

    create table if not exists platform_accounts (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      platform text not null,
      account_type text not null default 'social_page',
      external_account_id text not null,
      name text not null,
      handle text not null default '',
      avatar_url text not null default '',
      credential_id text,
      status text not null default 'connected',
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (organization_id, brand_id, platform, external_account_id)
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

  const orgId = "org_enterprise";
  const brandId = "brand_flagship";

  process.env.TOKEN_ENCRYPTION_KEY = TEST_SECRET;

  try {
    // 1. Connect Account 1: Instagram Main
    const acc1 = await connectPlatformAccount(sql, orgId, brandId, {
      platform: "instagram",
      accountType: "social_page",
      externalAccountId: "ig_page_101",
      name: "Flagship Official",
      handle: "@flagship_official",
      credentials: { accessToken: "token_ig_101" },
    });
    assert.ok(acc1.accountId);
    assert.ok(acc1.credentialId);

    // 2. Connect Account 2: Instagram EU (Multiple accounts per platform)
    const acc2 = await connectPlatformAccount(sql, orgId, brandId, {
      platform: "instagram",
      accountType: "social_page",
      externalAccountId: "ig_page_102",
      name: "Flagship Europe",
      handle: "@flagship_eu",
      credentials: { accessToken: "token_ig_102" },
    });
    assert.ok(acc2.accountId);

    // 3. Connect Account 3: YouTube Shorts Channel
    const acc3 = await connectPlatformAccount(sql, orgId, brandId, {
      platform: "youtube",
      accountType: "channel",
      externalAccountId: "yt_chan_201",
      name: "Flagship Shorts",
      handle: "@flagship_shorts",
      credentials: { accessToken: "token_yt_201", refreshToken: "ref_yt_201" },
    });
    assert.ok(acc3.accountId);

    // 4. List accounts for brand
    const accounts = await listBrandPlatformAccounts(sql, orgId, brandId);
    assert.equal(accounts.length, 3);

    // Filter by platform
    const igAccounts = await listBrandPlatformAccounts(sql, orgId, brandId, "instagram");
    assert.equal(igAccounts.length, 2);

    // 5. Decrypt credentials for Account 3
    const decryptedYt = await getAccountDecryptedCredential(sql, orgId, brandId, acc3.accountId);
    assert.ok(decryptedYt);
    assert.equal(decryptedYt.accessToken, "token_yt_201");
    assert.equal(decryptedYt.refreshToken, "ref_yt_201");

    // 6. Disconnect Account 1
    const disconnected = await disconnectPlatformAccount(sql, orgId, brandId, acc1.accountId);
    assert.equal(disconnected, true);

    const updatedAccounts = await listBrandPlatformAccounts(sql, orgId, brandId, "instagram");
    const acc1Updated = updatedAccounts.find((a) => a.id === acc1.accountId);
    assert.equal(acc1Updated?.status, "disconnected");
  } finally {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  }
});
