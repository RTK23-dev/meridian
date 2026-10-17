import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { encryptPayload } from "../vault/crypto.ts";
import { INSTAGRAM_PUBLISH_SCOPE, resolveOrganicConnection, resolveOrganicConnections, YOUTUBE_UPLOAD_SCOPE } from "./connection.ts";

const KEY = "connection-test-key";
const ORG = "org-1";
const BRAND = "brand-1";

function withKey<T>(fn: () => Promise<T>): () => Promise<T> {
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

function vaultRow(payload: Record<string, unknown>, key = KEY, expiresAt: string | null = null) {
  const envelope = encryptPayload(JSON.stringify(payload), key);
  return {
    id: "cred-1",
    organization_id: ORG,
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    tag: envelope.tag,
    key_version: envelope.keyVersion,
    expires_at: expiresAt,
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    external_account_id: "page-9",
    name: "Brand Page",
    credential_id: "cred-1",
    metadata: {},
    ...overrides,
  };
}

function fakeSql(options: { accounts?: unknown[]; vault?: unknown[] }) {
  const queries: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queries.push(text);
    if (text.includes("from platform_accounts")) return options.accounts ?? [];
    if (text.includes("from credential_vault")) return options.vault ?? [];
    return [];
  }) as unknown as Sql;
  return { sql, queries };
}

const input = { organizationId: ORG, brandId: BRAND };

test("no connected account for the brand is NOT_CONNECTED with a reason, and the account lookup is scoped to the workspace and brand", withKey(async () => {
  const { sql, queries } = fakeSql({ accounts: [] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "facebook" });
  assert.equal(state.connected, false);
  if (state.connected) return;
  assert.match(state.reason, /No Facebook Page account is connected/);
  assert.match(queries[0] ?? "", /organization_id = \?[\s\S]*brand_id = \?/);
}));

test("an account with no stored token is NOT_CONNECTED, and no vault read is attempted", withKey(async () => {
  const { sql, queries } = fakeSql({ accounts: [account({ credential_id: null })] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "facebook" });
  assert.equal(state.connected, false);
  if (state.connected) return;
  assert.match(state.reason, /no stored access token/);
  assert.equal(queries.some((text) => text.includes("from credential_vault")), false);
}));

test("a vault entry that is gone is NOT_CONNECTED", withKey(async () => {
  const { sql } = fakeSql({ accounts: [account()], vault: [] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "instagram" });
  assert.equal(state.connected, false);
  if (state.connected) return;
  assert.match(state.reason, /no longer in the vault/);
}));

test("an expired vault token is NOT_CONNECTED", withKey(async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const { sql } = fakeSql({ accounts: [account()], vault: [vaultRow({ accessToken: "tok-old" }, KEY, past)] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "facebook" });
  assert.equal(state.connected, false);
  if (state.connected) return;
  assert.match(state.reason, /has expired/);
}));

test("a token that cannot be opened is NOT_CONNECTED and the reason does not reveal the token", withKey(async () => {
  const { sql } = fakeSql({ accounts: [account()], vault: [vaultRow({ accessToken: "tok-secret-abc" }, "some-other-key")] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "facebook" });
  assert.equal(state.connected, false);
  if (state.connected) return;
  assert.match(state.reason, /could not be opened/);
  assert.equal(state.reason.includes("tok-secret-abc"), false);
}));

test("a connected account resolves to its page id, name, and vault token", withKey(async () => {
  const { sql } = fakeSql({ accounts: [account({ metadata: "{}" })], vault: [vaultRow({ accessToken: "  tok-abc  " })] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "facebook" });
  assert.equal(state.connected, true);
  if (!state.connected) return;
  assert.equal(state.accountId, "page-9");
  assert.equal(state.accountName, "Brand Page");
  assert.equal(state.accessToken, "tok-abc");
  assert.equal(state.scopes, null);
}));

test("a YouTube token that declares scopes without the upload scope is NOT_CONNECTED", withKey(async () => {
  const payload = { accessToken: "yt-tok", customFields: { scopes: "https://www.googleapis.com/auth/youtube.readonly" } };
  const { sql } = fakeSql({ accounts: [account({ external_account_id: "channel-1" })], vault: [vaultRow(payload)] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "youtube" });
  assert.equal(state.connected, false);
  if (state.connected) return;
  assert.match(state.reason, new RegExp(YOUTUBE_UPLOAD_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}));

test("a YouTube token that declares the upload scope is connected, and its scopes are reported", withKey(async () => {
  const payload = { accessToken: "yt-tok", customFields: { scopes: [YOUTUBE_UPLOAD_SCOPE, "https://www.googleapis.com/auth/youtube.readonly"] } };
  const { sql } = fakeSql({ accounts: [account({ external_account_id: "channel-1" })], vault: [vaultRow(payload)] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "youtube" });
  assert.equal(state.connected, true);
  if (!state.connected) return;
  assert.deepEqual(state.scopes, [YOUTUBE_UPLOAD_SCOPE, "https://www.googleapis.com/auth/youtube.readonly"]);
}));

test("a YouTube token that does not declare scopes is connected, and the upload is the check", withKey(async () => {
  const { sql } = fakeSql({ accounts: [account({ external_account_id: "channel-1" })], vault: [vaultRow({ accessToken: "yt-tok" })] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "youtube" });
  assert.equal(state.connected, true);
  if (!state.connected) return;
  assert.equal(state.scopes, null);
}));

test("a TikTok token that declares scopes without video.publish is NOT_CONNECTED", withKey(async () => {
  const payload = { accessToken: "tt-tok", customFields: { scopes: "user.info.basic" } };
  const { sql } = fakeSql({ accounts: [account({ external_account_id: "open-id-1" })], vault: [vaultRow(payload)] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "tiktok" });
  assert.equal(state.connected, false);
  if (state.connected) return;
  assert.match(state.reason, /video\.publish/);
}));

test("a TikTok token that declares video.publish is connected, and its scopes are reported", withKey(async () => {
  const payload = { accessToken: "tt-tok", customFields: { scopes: "user.info.basic,video.publish" } };
  const { sql } = fakeSql({ accounts: [account({ external_account_id: "open-id-1" })], vault: [vaultRow(payload)] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "tiktok" });
  assert.equal(state.connected, true);
  if (!state.connected) return;
  assert.deepEqual(state.scopes, ["user.info.basic", "video.publish"]);
}));

test("a read connection needs no publish scope, so a read-only YouTube token resolves; a publish connection still refuses it", withKey(async () => {
  const payload = { accessToken: "yt-read", customFields: { scopes: "https://www.googleapis.com/auth/youtube.readonly" } };
  const { sql } = fakeSql({ accounts: [account()], vault: [vaultRow(payload)] });
  const read = await resolveOrganicConnection(sql, { ...input, platform: "youtube", purpose: "read" });
  assert.equal(read.connected, true, "a read token is not refused for lacking the upload scope");
  if (read.connected) assert.deepEqual(read.scopes, ["https://www.googleapis.com/auth/youtube.readonly"]);

  const publish = await resolveOrganicConnection(sql, { ...input, platform: "youtube" });
  assert.equal(publish.connected, false, "publishing still needs the upload scope");
}));

test("a read connection for TikTok resolves with video.list and no video.publish", withKey(async () => {
  const payload = { accessToken: "tt-read", customFields: { scopes: "video.list" } };
  const { sql } = fakeSql({ accounts: [account({ external_account_id: "open-id-2" })], vault: [vaultRow(payload)] });
  const read = await resolveOrganicConnection(sql, { ...input, platform: "tiktok", purpose: "read" });
  assert.equal(read.connected, true);
  const publish = await resolveOrganicConnection(sql, { ...input, platform: "tiktok" });
  assert.equal(publish.connected, false, "publishing still needs video.publish");
}));

test("an Instagram token that declares scopes without instagram_content_publish is NOT_CONNECTED", withKey(async () => {
  const payload = { accessToken: "ig-tok", customFields: { scopes: "instagram_basic" } };
  const { sql } = fakeSql({ accounts: [account({ external_account_id: "1789" })], vault: [vaultRow(payload)] });
  const state = await resolveOrganicConnection(sql, { ...input, platform: "instagram" });
  assert.equal(state.connected, false);
  if (state.connected) return;
  assert.match(state.reason, new RegExp(INSTAGRAM_PUBLISH_SCOPE));
  const read = await resolveOrganicConnection(sql, { ...input, platform: "instagram", purpose: "read" });
  assert.equal(read.connected, true, "a metrics read is not refused for lacking the publish scope");
}));

test("resolveOrganicConnections returns every organic platform, each with its own state", withKey(async () => {
  const { sql } = fakeSql({ accounts: [] });
  const states = await resolveOrganicConnections(sql, input);
  assert.deepEqual(Object.keys(states).sort(), ["facebook", "instagram", "tiktok", "youtube"]);
  for (const state of Object.values(states)) assert.equal(state.connected, false);
}));
