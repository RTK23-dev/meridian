/**
 * Re-encrypts every value sealed with TOKEN_ENCRYPTION_KEY under the current key, after the key changed. `npm run keys:rotate`
 * (scripts/rotate-encryption-key.ts) runs it. The encrypted columns, and their formats (vault/crypto.ts):
 * - credential_vault.ciphertext (with iv and tag): the envelope, sealed with the trimmed key (vault/service.ts, drive store).
 * - provider_secrets.sealed_token and provider_secrets.sealed_refresh: the compact seal, sealed with the key as set.
 * - artifact_upload_sessions.session_uri: "sealed:v1:" + the envelope as base64url JSON, sealed with the trimmed key.
 *
 * Each value is opened with the current key first, then the previous one. A value the current key opens is already current and is
 * not written. A value only the previous key opens is re-encrypted with the current key. A value neither key opens is counted and
 * left exactly as it is. Batches run in transactions, rows are locked while they are read, and a write only lands when the stored
 * value is still the one that was read. The result is counts only: no plaintext, ciphertext or key leaves this module.
 */
import type { Sql } from "../learning/store.ts";
import type { SecretEnv } from "../credentials/secret-settings.ts";
import { tokenEncryptionKey, tokenEncryptionKeyPrevious } from "../credentials/secret-settings.ts";
import { decryptionKeys, decryptPayloadWithKeys, encryptPayload, openCompactWithKeys, sealCompact } from "./crypto.ts";
import { sealedSessionEnvelope, sealSessionUri } from "../storage/session-seal.ts";

export const ENCRYPTED_COLUMNS = [
  "credential_vault.ciphertext",
  "provider_secrets.sealed_token",
  "provider_secrets.sealed_refresh",
  "artifact_upload_sessions.session_uri",
] as const;

export type EncryptedColumn = (typeof ENCRYPTED_COLUMNS)[number];

export type ColumnCount = {
  column: EncryptedColumn;
  /** Opened only by the previous key: re-encrypted on a real run. */
  reencryptable: number;
  /** Already opened by the current key. */
  current: number;
  /** Opened by neither key. Left as it is. */
  unreadable: number;
  /** Rows written by this run (0 on a dry run). */
  reencrypted: number;
};

export type RotationKeys = { current: string; previous: string };

export class RotationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RotationRefused";
  }
}

/** The two keys a rotation needs. Refuses when either is blank or when they are the same value. Never echoes a key. */
export function rotationKeys(env: SecretEnv = process.env): RotationKeys {
  const current = tokenEncryptionKey(env) ?? "";
  const previous = tokenEncryptionKeyPrevious(env) ?? "";
  if (!current.trim()) throw new RotationRefused("TOKEN_ENCRYPTION_KEY is not set. Set the new key there before rotating. Nothing was changed.");
  if (!previous.trim()) {
    throw new RotationRefused("TOKEN_ENCRYPTION_KEY_PREVIOUS is not set. Set the old key there and the new key in TOKEN_ENCRYPTION_KEY. Nothing was changed.");
  }
  if (previous.trim() === current.trim()) {
    throw new RotationRefused("TOKEN_ENCRYPTION_KEY_PREVIOUS is the same as TOKEN_ENCRYPTION_KEY, so there is nothing to rotate. Nothing was changed.");
  }
  return { current, previous };
}

type Outcome = { state: "current" } | { state: "unreadable" } | { state: "reencryptable"; next: string };

/** Classifies one stored value. `open` throws when no key opens it; `reseal` encrypts the plaintext with the current key. */
function classify(open: () => { plaintext: string; keyIndex: number }, reseal: (plaintext: string) => string): Outcome {
  let opened: { plaintext: string; keyIndex: number };
  try {
    opened = open();
  } catch {
    return { state: "unreadable" };
  }
  if (opened.keyIndex === 0) return { state: "current" };
  return { state: "reencryptable", next: reseal(opened.plaintext) };
}

function emptyCount(column: EncryptedColumn): ColumnCount {
  return { column, reencryptable: 0, current: 0, unreadable: 0, reencrypted: 0 };
}

function tally(count: ColumnCount, outcome: Outcome): void {
  count[outcome.state] += 1;
}

async function inBatch<T>(sql: Sql, dryRun: boolean, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (dryRun) return fn(sql);
  if (!sql.begin) throw new RotationRefused("This database connection cannot run a transaction, so nothing was changed.");
  return sql.begin(fn);
}

type Options = { dryRun?: boolean; batchSize?: number };

export async function rotateEncryptedColumns(sql: Sql, keys: RotationKeys, options: Options = {}): Promise<ColumnCount[]> {
  const dryRun = options.dryRun ?? false;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 200));
  const lock = dryRun ? "" : " for update";
  // The app seals vault envelopes and session URIs with the trimmed key, and compact seals with the key as set.
  const trimmed = keys.current.trim();
  const envelopeKeys = decryptionKeys(trimmed, keys.previous);
  const compactKeys = decryptionKeys(keys.current, keys.previous);

  const vault = emptyCount("credential_vault.ciphertext");
  for (let last = ""; ; ) {
    const done = await inBatch(sql, dryRun, async (tx) => {
      const rows = await tx.query<{ id: string; ciphertext: string; iv: string; tag: string }>(
        `select id, ciphertext, iv, tag from credential_vault where id > $1 order by id limit $2${lock}`,
        [last, batchSize],
      );
      for (const row of rows) {
        const outcome = classify(
          () => decryptPayloadWithKeys(row, envelopeKeys),
          (plaintext) => JSON.stringify(encryptPayload(plaintext, trimmed)),
        );
        tally(vault, outcome);
        if (!dryRun && outcome.state === "reencryptable") {
          const next = JSON.parse(outcome.next) as { ciphertext: string; iv: string; tag: string };
          const written = await tx.query(
            `update credential_vault set ciphertext = $2, iv = $3, tag = $4
             where id = $1 and ciphertext = $5 and iv = $6 and tag = $7 returning id`,
            [row.id, next.ciphertext, next.iv, next.tag, row.ciphertext, row.iv, row.tag],
          );
          vault.reencrypted += written.length;
        }
      }
      last = rows.at(-1)?.id ?? last;
      return rows.length < batchSize;
    });
    if (done) break;
  }

  const token = emptyCount("provider_secrets.sealed_token");
  const refresh = emptyCount("provider_secrets.sealed_refresh");
  for (let last = ""; ; ) {
    const done = await inBatch(sql, dryRun, async (tx) => {
      const rows = await tx.query<{ id: string; sealed_token: string; sealed_refresh: string }>(
        `select id, sealed_token, sealed_refresh from provider_secrets where id > $1 order by id limit $2${lock}`,
        [last, batchSize],
      );
      for (const row of rows) {
        const outcomes = ([[row.sealed_token, token], [row.sealed_refresh, refresh]] as const).map(([value, count]) => {
          if (!value) return null;
          const outcome = classify(() => openCompactWithKeys(value, compactKeys), (plaintext) => sealCompact(plaintext, keys.current));
          tally(count, outcome);
          return outcome;
        });
        const [tokenOutcome, refreshOutcome] = outcomes;
        const nextToken = tokenOutcome?.state === "reencryptable" ? tokenOutcome.next : row.sealed_token;
        const nextRefresh = refreshOutcome?.state === "reencryptable" ? refreshOutcome.next : row.sealed_refresh;
        if (dryRun || (nextToken === row.sealed_token && nextRefresh === row.sealed_refresh)) continue;
        const written = await tx.query(
          `update provider_secrets set sealed_token = $2, sealed_refresh = $3
           where id = $1 and sealed_token = $4 and sealed_refresh = $5 returning id`,
          [row.id, nextToken, nextRefresh, row.sealed_token, row.sealed_refresh],
        );
        if (written.length > 0) {
          if (nextToken !== row.sealed_token) token.reencrypted += 1;
          if (nextRefresh !== row.sealed_refresh) refresh.reencrypted += 1;
        }
      }
      last = rows.at(-1)?.id ?? last;
      return rows.length < batchSize;
    });
    if (done) break;
  }

  const sessions = emptyCount("artifact_upload_sessions.session_uri");
  for (let last = ""; ; ) {
    const done = await inBatch(sql, dryRun, async (tx) => {
      const rows = await tx.query<{ id: string; session_uri: string }>(
        `select id, session_uri from artifact_upload_sessions where id > $1 and session_uri <> '' order by id limit $2${lock}`,
        [last, batchSize],
      );
      for (const row of rows) {
        const envelope = sealedSessionEnvelope(row.session_uri);
        const outcome: Outcome = envelope
          ? classify(() => decryptPayloadWithKeys(envelope, envelopeKeys), (plaintext) => sealSessionUri(plaintext, trimmed))
          : { state: "unreadable" };
        tally(sessions, outcome);
        if (!dryRun && outcome.state === "reencryptable") {
          const written = await tx.query(
            `update artifact_upload_sessions set session_uri = $2 where id = $1 and session_uri = $3 returning id`,
            [row.id, outcome.next, row.session_uri],
          );
          sessions.reencrypted += written.length;
        }
      }
      last = rows.at(-1)?.id ?? last;
      return rows.length < batchSize;
    });
    if (done) break;
  }

  return [vault, token, refresh, sessions];
}

/** One line per column, counts only. */
export function formatRotationReport(counts: readonly ColumnCount[], dryRun: boolean): string[] {
  return counts.map((count) =>
    dryRun
      ? `${count.column}: re-encryptable ${count.reencryptable}, already current ${count.current}, unreadable with both keys ${count.unreadable}`
      : `${count.column}: re-encrypted ${count.reencrypted} of ${count.reencryptable}, already current ${count.current}, unreadable with both keys ${count.unreadable} (left as they are)`,
  );
}
