// npm run keys:rotate [-- --dry-run]
// Re-encrypts every value sealed with TOKEN_ENCRYPTION_KEY_PREVIOUS under TOKEN_ENCRYPTION_KEY (src/lib/meridian/vault/rotate.ts).
// Needs DATABASE_URL and both keys. Prints counts per table.column only: never a plaintext, a ciphertext or a key.
import pg from "pg";
import { createPoolSql } from "../src/lib/meridian/learning/pool-sql.ts";
import { formatRotationReport, rotateEncryptedColumns, rotationKeys, RotationRefused } from "../src/lib/meridian/vault/rotate.ts";

const dryRun = process.argv.includes("--dry-run");
const unknown = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
if (unknown.length > 0) {
  console.error("[keys:rotate] The only option is --dry-run. Nothing was changed.");
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("[keys:rotate] DATABASE_URL is required. The embedded development database is not rotated by this command. Nothing was changed.");
  process.exit(1);
}

let keys;
try {
  keys = rotationKeys();
} catch (error) {
  console.error(`[keys:rotate] ${error instanceof RotationRefused ? error.message : "The keys could not be read. Nothing was changed."}`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, ssl: databaseUrl.includes("sslmode=disable") ? false : undefined });
try {
  const counts = await rotateEncryptedColumns(createPoolSql(pool), keys, { dryRun });
  console.log(dryRun ? "[keys:rotate] Dry run. Nothing was changed." : "[keys:rotate] Done.");
  for (const line of formatRotationReport(counts, dryRun)) console.log(`  ${line}`);
  const unreadable = counts.reduce((sum, count) => sum + count.unreadable, 0);
  if (unreadable > 0) {
    console.log(`[keys:rotate] ${unreadable} value(s) open with neither key. They were left as they are; save those keys or connections again.`);
  }
} catch (error) {
  // A database error message names tables and columns, never a stored value, since values are passed as parameters.
  console.error(`[keys:rotate] Failed: ${error instanceof Error ? error.message : "unknown error"}. Batches already committed stay re-encrypted; run it again to finish.`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
