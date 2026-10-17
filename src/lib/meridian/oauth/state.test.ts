import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../learning/store.ts";
import { claimOauthState } from "./state.ts";

const INITIATOR = "user-admin";

// The state table as migrations 0009, 0061 and 0095 leave it, without the organizations and user foreign keys this test does not need.
async function freshDatabase() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    create table oauth_states (
      state_hash text primary key,
      organization_id text not null,
      provider text not null,
      expires_at timestamptz not null,
      used_at timestamptz,
      redirect_origin text,
      user_id text,
      return_path text
    );
  `);
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return pg.query(text, values).then((result) => result.rows);
  }) as unknown as Sql;
  return { pg, sql };
}

async function startAttempt(
  pg: PGlite,
  row: { stateHash: string; provider?: string; origin?: string | null; expiresIn?: string; userId?: string | null },
) {
  await pg.query(
    `insert into oauth_states (state_hash, organization_id, provider, expires_at, redirect_origin, user_id)
     values ($1, 'org-oauth', $2, now() + $3::interval, $4, $5)`,
    [
      row.stateHash,
      row.provider ?? "meta",
      row.expiresIn ?? "10 minutes",
      row.origin === undefined ? "https://meridian.example" : row.origin,
      row.userId === undefined ? INITIATOR : row.userId,
    ],
  );
}

test("a state is claimed once: the second presentation of the same state gets nothing", async () => {
  const { pg, sql } = await freshDatabase();
  await startAttempt(pg, { stateHash: "hash-once" });
  const first = await claimOauthState(sql, { stateHash: "hash-once", userId: INITIATOR, provider: "meta", origin: "https://meridian.example" });
  const second = await claimOauthState(sql, { stateHash: "hash-once", userId: INITIATOR, provider: "meta", origin: "https://meridian.example" });
  assert.deepEqual(first, { organizationId: "org-oauth", redirectOrigin: "https://meridian.example", returnPath: null });
  assert.equal(second, null);
});

test("a callback from another origin cannot consume the state, and the state still works from its own origin", async () => {
  const { pg, sql } = await freshDatabase();
  await startAttempt(pg, { stateHash: "hash-origin" });
  const wrong = await claimOauthState(sql, { stateHash: "hash-origin", userId: INITIATOR, provider: "meta", origin: "https://attacker.example" });
  assert.equal(wrong, null);
  const right = await claimOauthState(sql, { stateHash: "hash-origin", userId: INITIATOR, provider: "meta", origin: "https://meridian.example" });
  assert.equal(right?.redirectOrigin, "https://meridian.example", "the failed attempt did not mark the state used");
});

test("a state started by one person is not claimed by another signed-in person, and stays usable by the initiator", async () => {
  const { pg, sql } = await freshDatabase();
  await startAttempt(pg, { stateHash: "hash-person" });
  const other = await claimOauthState(sql, { stateHash: "hash-person", userId: "user-victim", provider: "meta", origin: "https://meridian.example" });
  assert.equal(other, null, "the victim's consent must not bind a token to the initiator's workspace");
  const initiator = await claimOauthState(sql, { stateHash: "hash-person", userId: INITIATOR, provider: "meta", origin: "https://meridian.example" });
  assert.equal(initiator?.organizationId, "org-oauth");
});

test("a state presented for another provider is not claimed", async () => {
  const { pg, sql } = await freshDatabase();
  await startAttempt(pg, { stateHash: "hash-provider", provider: "meta" });
  const claimed = await claimOauthState(sql, { stateHash: "hash-provider", userId: INITIATOR, provider: "tiktok", origin: "https://meridian.example" });
  assert.equal(claimed, null);
});

test("an expired state is not claimed", async () => {
  const { pg, sql } = await freshDatabase();
  await startAttempt(pg, { stateHash: "hash-expired", expiresIn: "-1 minute" });
  const claimed = await claimOauthState(sql, { stateHash: "hash-expired", userId: INITIATOR, provider: "meta", origin: "https://meridian.example" });
  assert.equal(claimed, null);
});

test("a state begun before the origin was stored has no origin, so it cannot be claimed", async () => {
  const { pg, sql } = await freshDatabase();
  await startAttempt(pg, { stateHash: "hash-legacy", origin: null });
  const claimed = await claimOauthState(sql, { stateHash: "hash-legacy", userId: INITIATOR, provider: "meta", origin: "https://meridian.example" });
  assert.equal(claimed, null);
});

test("a state begun before the initiator was stored has no user, so it cannot be claimed", async () => {
  const { pg, sql } = await freshDatabase();
  await startAttempt(pg, { stateHash: "hash-no-user", userId: null });
  const claimed = await claimOauthState(sql, { stateHash: "hash-no-user", userId: INITIATOR, provider: "meta", origin: "https://meridian.example" });
  assert.equal(claimed, null);
});

test("a state that was never issued is not claimed", async () => {
  const { sql } = await freshDatabase();
  const claimed = await claimOauthState(sql, { stateHash: "hash-unknown", userId: INITIATOR, provider: "meta", origin: "https://meridian.example" });
  assert.equal(claimed, null);
});
