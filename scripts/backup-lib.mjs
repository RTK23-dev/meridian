// @ts-check
/**
 * Pure helpers for `scripts/backup.mjs` (npm run db:backup, db:restore, db:restore-drill). Nothing here touches the disk, the network
 * or a process: file naming, retention, argument checks, connection settings for the PostgreSQL client tools, and the drill report.
 * Tested in scripts/backup.test.mjs.
 */

/** The prefix and extension of every backup this script writes. Retention only ever deletes files that match both. */
export const BACKUP_PREFIX = "meridian-";
export const BACKUP_EXT = ".dump";
/** The sidecar beside each backup: `<sha256>  <file name>`, the format `sha256sum -c` reads. */
export const CHECKSUM_EXT = ".sha256";
/** The row counts taken in the same snapshot as the dump, used by the restore drill. */
export const COUNTS_EXT = ".counts.json";
export const DEFAULT_KEEP = 14;
/** How many of the largest tables the drill compares. */
export const DRILL_TABLES = 20;

const NAME_PATTERN = /^meridian-([a-z0-9_]{1,40})-(\d{8}T\d{6}Z)\.dump$/;

/**
 * A database name made safe for a file name: lower case, letters, digits and underscores, at most 40 characters.
 * @param {string} name
 */
export function safeDatabaseLabel(name) {
  const label = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return label || "db";
}

/**
 * The UTC timestamp used in a backup's name, e.g. 20261118T031500Z. Sorting the names sorts them by time.
 * @param {Date} date
 */
export function backupStamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/**
 * The file name of a backup taken at `date` of database `databaseName`.
 * @param {Date} date
 * @param {string} databaseName
 */
export function backupFileName(date, databaseName) {
  return `${BACKUP_PREFIX}${safeDatabaseLabel(databaseName)}-${backupStamp(date)}${BACKUP_EXT}`;
}

/**
 * The parts of a backup file name, or null when the name is not one this script wrote.
 * @param {string} fileName
 * @returns {{ label: string, stamp: string } | null}
 */
export function parseBackupFileName(fileName) {
  const match = NAME_PATTERN.exec(fileName);
  return match ? { label: match[1], stamp: match[2] } : null;
}

/**
 * The backups among `fileNames`, newest first. Ordered by timestamp, then by name, so the order never depends on the directory.
 * @param {string[]} fileNames
 */
export function backupsNewestFirst(fileNames) {
  return fileNames
    .map((name) => ({ name, parsed: parseBackupFileName(name) }))
    .filter((entry) => entry.parsed !== null)
    .sort((a, b) => {
      const byStamp = (b.parsed?.stamp ?? "").localeCompare(a.parsed?.stamp ?? "");
      return byStamp !== 0 ? byStamp : b.name.localeCompare(a.name);
    })
    .map((entry) => entry.name);
}

/**
 * Which files retention deletes: every backup older than the newest `keep`, with its sidecars. Files this script did not write are
 * never listed. `keep` below 1 is refused, so retention can never delete the backup just made.
 * @param {string[]} fileNames
 * @param {number} keep
 */
export function selectForDeletion(fileNames, keep) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("keep must be a whole number of at least 1.");
  const present = new Set(fileNames);
  const doomed = [];
  for (const name of backupsNewestFirst(fileNames).slice(keep)) {
    doomed.push(name);
    for (const ext of [CHECKSUM_EXT, COUNTS_EXT]) if (present.has(name + ext)) doomed.push(name + ext);
  }
  return doomed;
}

/**
 * BACKUP_KEEP as a number. Blank uses the default. Anything that is not a whole number from 1 to 1000 is an error, never a guess.
 * @param {string | undefined} raw
 * @returns {{ ok: true, keep: number } | { ok: false, error: string }}
 */
export function parseKeep(raw) {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, keep: DEFAULT_KEEP };
  if (!/^\d+$/.test(text)) return { ok: false, error: "BACKUP_KEEP must be a whole number from 1 to 1000." };
  const keep = Number(text);
  if (keep < 1 || keep > 1000) return { ok: false, error: "BACKUP_KEEP must be a whole number from 1 to 1000." };
  return { ok: true, keep };
}

/**
 * The parts of a postgres:// URL that identify one database. The password is never part of the result.
 * @param {string} url
 * @returns {{ host: string, port: string, database: string, user: string } | null}
 */
export function databaseIdentity(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) return null;
  let host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") host = "127.0.0.1";
  return { host, port: parsed.port || "5432", database, user: decodeURIComponent(parsed.username) };
}

/**
 * True when both URLs name the same database on the same server. Unparseable URLs count as the same, so a check fails closed.
 * @param {string} a
 * @param {string} b
 */
export function sameDatabase(a, b) {
  const left = databaseIdentity(a);
  const right = databaseIdentity(b);
  if (!left || !right) return true;
  return left.host === right.host && left.port === right.port && left.database === right.database;
}

/**
 * The libpq environment for the PostgreSQL client tools, so the password is never on a command line (where `ps` shows it).
 * @param {string} url
 * @returns {Record<string, string>}
 */
export function libpqEnv(url) {
  const parsed = new URL(url);
  const identity = databaseIdentity(url);
  if (!identity) throw new Error("The database URL is not a postgres:// URL with a database name.");
  /** @type {Record<string, string>} */
  const env = { PGHOST: parsed.hostname.replace(/^\[|\]$/g, ""), PGPORT: identity.port, PGDATABASE: identity.database };
  if (identity.user) env.PGUSER = identity.user;
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/**
 * The same URL pointed at another database on the same server.
 * @param {string} url
 * @param {string} database
 */
export function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/**
 * A name for the drill's scratch database. Only letters, digits and underscores, so it needs no quoting rules beyond double quotes.
 * @param {Date} date
 */
export function scratchDatabaseName(date) {
  return `meridian_drill_${backupStamp(date).toLowerCase()}`;
}

/**
 * Checks the arguments of `npm run db:restore -- <file> [--into-live] [--clean]`.
 * @param {{ args: string[], databaseUrl: string, restoreUrl: string }} input
 * @returns {{ ok: true, file: string, targetUrl: string, intoLive: boolean, clean: boolean } | { ok: false, error: string }}
 */
export function checkRestoreArgs(input) {
  const flags = input.args.filter((arg) => arg.startsWith("--"));
  const positional = input.args.filter((arg) => !arg.startsWith("--"));
  const unknown = flags.filter((flag) => flag !== "--into-live" && flag !== "--clean");
  if (unknown.length) return { ok: false, error: `Unknown option ${unknown[0]}. The options are --into-live and --clean.` };
  if (positional.length !== 1) return { ok: false, error: "Name one backup file: npm run db:restore -- backups/<file>.dump" };
  const intoLive = flags.includes("--into-live");
  const clean = flags.includes("--clean");
  const restoreUrl = input.restoreUrl.trim();
  const databaseUrl = input.databaseUrl.trim();
  if (intoLive) {
    if (!databaseUrl) return { ok: false, error: "--into-live restores into DATABASE_URL, and DATABASE_URL is not set." };
    if (restoreUrl && !sameDatabase(restoreUrl, databaseUrl)) {
      return { ok: false, error: "--into-live restores into DATABASE_URL. Leave RESTORE_DATABASE_URL unset, or drop --into-live." };
    }
    return { ok: true, file: positional[0], targetUrl: databaseUrl, intoLive, clean };
  }
  if (!restoreUrl) return { ok: false, error: "Set RESTORE_DATABASE_URL to the database to restore into. It should be an empty database." };
  if (!databaseIdentity(restoreUrl)) return { ok: false, error: "RESTORE_DATABASE_URL is not a postgres:// URL with a database name." };
  if (databaseUrl && sameDatabase(restoreUrl, databaseUrl)) {
    return {
      ok: false,
      error: "RESTORE_DATABASE_URL is the live database (DATABASE_URL). Restore into another database, or pass --into-live to overwrite the live one.",
    };
  }
  return { ok: true, file: positional[0], targetUrl: restoreUrl, intoLive, clean };
}

/**
 * Whether the typed confirmation for --into-live matches the database name exactly.
 * @param {string} typed
 * @param {string} databaseName
 */
export function confirmationMatches(typed, databaseName) {
  return typed.trim() === databaseName && databaseName.length > 0;
}

/**
 * The first line of a `.sha256` sidecar for a file.
 * @param {string} hex
 * @param {string} fileName
 */
export function checksumLine(hex, fileName) {
  return `${hex}  ${fileName}\n`;
}

/**
 * The hash in a `.sha256` sidecar, or null when the text is not one.
 * @param {string} text
 */
export function parseChecksumLine(text) {
  const match = /^([0-9a-f]{64})\s/.exec(text.trim() + " ");
  return match ? match[1] : null;
}

/**
 * The major version in `pg_dump --version` or `SHOW server_version` output, or null.
 * @param {string} text
 */
export function majorVersion(text) {
  const match = /(\d+)(?:\.\d+)?/.exec(text.replace(/^[^\d]*/, ""));
  return match ? Number(match[1]) : null;
}

/**
 * A SQL identifier in double quotes, for a schema or table name read from the catalog.
 * @param {string} name
 */
export function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * What to install when the PostgreSQL client tools are missing or too old.
 * @param {number | null} serverMajor
 */
export function installHint(serverMajor) {
  const major = serverMajor ?? 16;
  return [
    `Install the PostgreSQL ${major} client tools (pg_dump, pg_restore, psql), version ${major} or newer:`,
    `  Debian or Ubuntu: apt-get install postgresql-client-${major}  (add the apt.postgresql.org repository if your release does not carry ${major})`,
    "  macOS:            brew install libpq, then add $(brew --prefix libpq)/bin to PATH",
    "  Docker or Railway: run this from a machine or job that has them; the Meridian image does not include them.",
  ].join("\n");
}

/**
 * @typedef {{ table: string, atBackup: number | null, restored: number | null, sourceNow: number | null }} CountRow
 * @typedef {{ table: string, atBackup: number | null, restored: number | null, sourceNow: number | null, ok: boolean, note: string }} JudgedRow
 */

/**
 * Judges the row counts of each compared table. With counts taken in the backup's own snapshot, a restored table must match them
 * exactly. Without them (a backup from elsewhere), the restored count is compared with the source now, and it may differ by the
 * rows written since the backup: at most `tolerance` (a fraction) of the source count, and at least 10 rows.
 * @param {CountRow[]} rows
 * @param {{ tolerance?: number }} [options]
 * @returns {JudgedRow[]}
 */
export function judgeCounts(rows, options = {}) {
  const tolerance = options.tolerance ?? 0.01;
  return rows.map((row) => {
    if (row.restored === null) return { ...row, ok: false, note: "missing after restore" };
    if (row.atBackup !== null) {
      const ok = row.restored === row.atBackup;
      return { ...row, ok, note: ok ? "exact" : `expected ${row.atBackup}` };
    }
    if (row.sourceNow === null) return { ...row, ok: false, note: "no count to compare with" };
    const allowed = Math.max(10, Math.ceil(row.sourceNow * tolerance));
    const diff = Math.abs(row.sourceNow - row.restored);
    return { ...row, ok: diff <= allowed, note: diff <= allowed ? `within ${allowed} of source` : `differs by ${diff} (allowed ${allowed})` };
  });
}

/**
 * The drill's printed report. `dropped` is null when the scratch database was never created. PASS only when the restore, the checksum and the migrator succeeded and every compared table is ok.
 * @param {{
 *   backup: string, sizeBytes: number | null, checksum: "ok" | "missing" | "mismatch",
 *   scratch: string, dropped: boolean | null, restoreSeconds: number | null, restoreError: string | null,
 *   migrate: { ok: boolean, applied: number | null, detail: string },
 *   rows: JudgedRow[], countsSource: "snapshot" | "live",
 * }} input
 * @returns {{ pass: boolean, text: string }}
 */
export function formatDrillReport(input) {
  const failures = [];
  if (input.checksum === "mismatch") failures.push("the backup does not match its sha256 file");
  if (input.restoreError) failures.push(`the restore failed: ${input.restoreError}`);
  if (!input.migrate.ok) failures.push(`the migrator failed on the restored copy: ${input.migrate.detail}`);
  if (!input.restoreError && input.rows.length === 0) failures.push("no table was compared");
  const bad = input.rows.filter((row) => !row.ok);
  if (bad.length) failures.push(`${bad.length} table(s) do not match`);
  const pass = failures.length === 0;

  const size = input.sizeBytes === null ? "size unknown" : `${(input.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  const lines = [
    `Restore drill: ${pass ? "PASS" : "FAIL"}`,
    `  backup    ${input.backup} (${size}, sha256 ${input.checksum})`,
    `  scratch   ${input.scratch} (${input.dropped === null ? "not created" : input.dropped ? "dropped" : "NOT dropped: drop it by hand"})`,
    `  restore   ${input.restoreError ? "failed" : `ok in ${input.restoreSeconds?.toFixed(1) ?? "?"} s`}`,
    `  migrate   ${input.migrate.ok ? (input.migrate.applied === 0 ? "up to date, nothing applied" : `${input.migrate.applied ?? "?"} applied`) : "failed"}`,
    `  counts    ${input.countsSource === "snapshot" ? "taken in the backup's own snapshot: must match exactly" : "no snapshot counts: compared with the source now"}`,
  ];
  if (input.rows.length) {
    const width = Math.max(5, ...input.rows.map((row) => row.table.length));
    lines.push("");
    lines.push(`  ${"table".padEnd(width)}  ${"at backup".padStart(10)}  ${"restored".padStart(10)}  ${"source now".padStart(10)}  result`);
    for (const row of input.rows) {
      const cell = (/** @type {number | null} */ value) => (value === null ? "-" : String(value)).padStart(10);
      lines.push(`  ${row.table.padEnd(width)}  ${cell(row.atBackup)}  ${cell(row.restored)}  ${cell(row.sourceNow)}  ${row.ok ? "ok" : "FAIL"} (${row.note})`);
    }
  }
  if (failures.length) {
    lines.push("");
    for (const failure of failures) lines.push(`  FAIL: ${failure}`);
  }
  return { pass, text: lines.join("\n") };
}

/** The message for a local trial: the embedded database is a folder, and copying it while the app is stopped is the backup. */
export const PGLITE_MESSAGE = [
  "DATABASE_URL is not set, so this is a local trial on the embedded database (PGlite).",
  "That database is the folder .data/pglite (or MERIDIAN_LOCAL_DATA_DIR when it is set).",
  "To back it up: stop `npm run dev`, then copy that folder, e.g. cp -a .data/pglite .data/pglite-backup-$(date +%Y%m%d).",
  "To restore: stop the app, replace the folder with the copy, start it again.",
  "Nothing was done.",
].join("\n");
