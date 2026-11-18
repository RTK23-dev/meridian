#!/usr/bin/env node
// @ts-check
/**
 * Database backups that are proven by a restore.
 *
 *   npm run db:backup                         pg_dump --format=custom of DATABASE_URL into backups/, with a .sha256 sidecar and the
 *                                             row counts of the 20 largest tables taken in the dump's own snapshot (.counts.json).
 *                                             Keeps the newest BACKUP_KEEP backups (default 14) and deletes older ones.
 *   npm run db:restore -- <file> [--clean]    pg_restore into RESTORE_DATABASE_URL, which must not be DATABASE_URL.
 *   npm run db:restore -- <file> --into-live  pg_restore into DATABASE_URL itself, after typing its name back (a terminal only).
 *   npm run db:restore-drill [-- <file>]      restores the newest backup into a scratch database on the same server, runs
 *                                             scripts/migrate.mjs against it, compares row counts, prints PASS or FAIL, drops it.
 *
 * Exit codes: 0 done (drill: PASS), 1 failed (drill: FAIL), 2 not run (no DATABASE_URL, missing tools, bad arguments).
 * The password is passed to the PostgreSQL tools through PGPASSWORD, never on a command line, and nothing here prints it.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  CHECKSUM_EXT,
  COUNTS_EXT,
  DRILL_TABLES,
  PGLITE_MESSAGE,
  backupFileName,
  backupsNewestFirst,
  checkRestoreArgs,
  checksumLine,
  confirmationMatches,
  databaseIdentity,
  formatDrillReport,
  installHint,
  judgeCounts,
  libpqEnv,
  majorVersion,
  parseChecksumLine,
  parseKeep,
  quoteIdent,
  scratchDatabaseName,
  selectForDeletion,
  withDatabase,
} from "./backup-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_DIR = join(ROOT, "backups");

class NotRun extends Error {}

/** @param {string} message */
function log(message) {
  console.log(`[backup] ${message}`);
}

/**
 * The installed version of one PostgreSQL client tool, or null when it is missing.
 * @param {string} tool
 */
function toolMajor(tool) {
  const result = spawnSync(tool, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return majorVersion(result.stdout);
}

/**
 * Refuses (NotRun) when a tool is missing or older than the server.
 * @param {string[]} tools
 * @param {number | null} serverMajor
 */
function requireTools(tools, serverMajor) {
  for (const tool of tools) {
    const major = toolMajor(tool);
    if (major === null) throw new NotRun(`${tool} was not found on PATH.\n${installHint(serverMajor)}`);
    if (serverMajor !== null && major < serverMajor) {
      throw new NotRun(`${tool} is version ${major}, older than the server (${serverMajor}). It cannot read this server.\n${installHint(serverMajor)}`);
    }
  }
}

/**
 * Runs a PostgreSQL tool with the connection in libpq variables. Resolves with its stderr; rejects with the stderr's last lines.
 * @param {string} tool
 * @param {string[]} args
 * @param {string} url
 */
function runTool(tool, args, url) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tool, args, { env: { ...process.env, ...libpqEnv(url) }, stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stderr);
      else reject(new Error(`${tool} exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ") || "no message"}`));
    });
  });
}

/** @param {string} path */
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** @param {string} url */
async function connect(url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
}

/** @param {pg.Client} client */
async function serverMajorOf(client) {
  const { rows } = await client.query("show server_version");
  return majorVersion(String(rows[0]?.server_version ?? ""));
}

/**
 * The largest user tables, by total size on disk.
 * @param {pg.Client} client
 * @param {number} limit
 * @returns {Promise<string[]>} qualified names, "schema.table"
 */
async function largestTables(client, limit) {
  const { rows } = await client.query(
    `select n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and not c.relispartition
        and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'
      order by pg_total_relation_size(c.oid) desc, n.nspname, c.relname
      limit $1`,
    [limit],
  );
  return rows.map((row) => `${row.schema}.${row.name}`);
}

/**
 * Exact row counts of the named tables. A table that does not exist has a null count.
 * @param {pg.Client} client
 * @param {string[]} tables
 * @returns {Promise<Map<string, number | null>>}
 */
async function countRows(client, tables) {
  const counts = new Map();
  for (const qualified of tables) {
    const dot = qualified.indexOf(".");
    const [schema, table] = [qualified.slice(0, dot), qualified.slice(dot + 1)];
    const exists = await client.query("select to_regclass($1) as oid", [`${quoteIdent(schema)}.${quoteIdent(table)}`]);
    if (!exists.rows[0]?.oid) {
      counts.set(qualified, null);
      continue;
    }
    const { rows } = await client.query(`select count(*)::bigint as n from ${quoteIdent(schema)}.${quoteIdent(table)}`);
    counts.set(qualified, Number(rows[0].n));
  }
  return counts;
}

function databaseUrlOrNotRun() {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  if (!url) throw new NotRun(PGLITE_MESSAGE);
  if (!databaseIdentity(url)) throw new NotRun("DATABASE_URL is not a postgres:// URL with a database name.");
  return url;
}

async function backup() {
  const url = databaseUrlOrNotRun();
  const keepResult = parseKeep(process.env.BACKUP_KEEP);
  if (!keepResult.ok) throw new NotRun(keepResult.error);
  const identity = databaseIdentity(url);
  if (!identity) throw new NotRun("DATABASE_URL is not a postgres:// URL with a database name.");

  const client = await connect(url);
  try {
    requireTools(["pg_dump"], await serverMajorOf(client));
    await mkdir(BACKUP_DIR, { recursive: true });
    const name = backupFileName(new Date(), identity.database);
    const finalPath = join(BACKUP_DIR, name);
    const partialPath = `${finalPath}.partial`;

    // The counts and the dump read the same snapshot, so the drill can require an exact match. The exporting transaction stays open
    // until pg_dump has finished. A server that cannot export a snapshot (a transaction-mode pooler) gets a plain dump and no counts.
    let snapshot = null;
    /** @type {Record<string, number | null> | null} */
    let counts = null;
    try {
      await client.query("begin isolation level repeatable read read only");
      snapshot = String((await client.query("select pg_export_snapshot() as s")).rows[0].s);
      const tables = await largestTables(client, DRILL_TABLES);
      counts = Object.fromEntries(await countRows(client, tables));
    } catch (error) {
      log(`Could not take the counts in the dump's snapshot (${error instanceof Error ? error.message : error}); dumping without them.`);
      snapshot = null;
      counts = null;
      await client.query("rollback").catch(() => {});
    }

    const started = Date.now();
    const args = ["--format=custom", "--compress=6", "--no-password", `--file=${partialPath}`];
    if (snapshot) args.push(`--snapshot=${snapshot}`);
    try {
      await runTool("pg_dump", args, url);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    } finally {
      if (snapshot) await client.query("commit").catch(() => {});
    }

    const hex = await sha256File(partialPath);
    await rename(partialPath, finalPath);
    await writeFile(finalPath + CHECKSUM_EXT, checksumLine(hex, name));
    if (counts) await writeFile(finalPath + COUNTS_EXT, `${JSON.stringify({ takenAt: new Date().toISOString(), tables: counts }, null, 2)}\n`);
    const size = (await stat(finalPath)).size;
    log(`Wrote backups/${name} (${(size / 1024 / 1024).toFixed(1)} MB) in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    log(`sha256 ${hex}${counts ? `; row counts of ${Object.keys(counts).length} tables recorded in the same snapshot` : ""}.`);

    const doomed = selectForDeletion(await readdir(BACKUP_DIR), keepResult.keep);
    for (const file of doomed) await rm(join(BACKUP_DIR, file), { force: true });
    if (doomed.length) log(`Retention (keep ${keepResult.keep}): deleted ${doomed.filter((file) => file.endsWith(".dump")).length} older backup(s).`);
    log("Copy backups/ off this machine: a backup on the same disk as the database is lost with it.");
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Checks a backup against its sidecar. "missing" when there is no sidecar.
 * @param {string} path
 * @returns {Promise<"ok" | "missing" | "mismatch">}
 */
async function verifyChecksum(path) {
  if (!existsSync(path + CHECKSUM_EXT)) return "missing";
  const expected = parseChecksumLine(await readFile(path + CHECKSUM_EXT, "utf8"));
  if (!expected) return "mismatch";
  return (await sha256File(path)) === expected ? "ok" : "mismatch";
}

/**
 * True when the database has any table outside the system schemas.
 * @param {string} url
 */
async function hasUserTables(url) {
  const client = await connect(url);
  try {
    const { rows } = await client.query(
      "select count(*)::int as n from pg_tables where schemaname not in ('pg_catalog', 'information_schema')",
    );
    return Number(rows[0].n) > 0;
  } finally {
    await client.end().catch(() => {});
  }
}

/** @param {string} url */
function restoreArgs(url, clean = false) {
  const identity = databaseIdentity(url);
  if (!identity) throw new NotRun("The restore target is not a postgres:// URL with a database name.");
  // One transaction: a restore that fails leaves the target as it was. --no-owner and --no-acl let any role that owns the target restore.
  const args = ["--no-owner", "--no-acl", "--single-transaction", "--no-password", `--dbname=${identity.database}`];
  if (clean) args.push("--clean", "--if-exists");
  return args;
}

/** @param {string[]} argv */
async function restore(argv) {
  const checked = checkRestoreArgs({
    args: argv,
    databaseUrl: process.env.DATABASE_URL ?? "",
    restoreUrl: process.env.RESTORE_DATABASE_URL ?? "",
  });
  if (!checked.ok) throw new NotRun(checked.error);
  const file = resolve(process.cwd(), checked.file);
  if (!existsSync(file)) throw new NotRun(`No backup at ${checked.file}.`);
  const target = databaseIdentity(checked.targetUrl);
  if (!target) throw new NotRun("The restore target is not a postgres:// URL with a database name.");

  const checksum = await verifyChecksum(file);
  if (checksum === "mismatch") throw new Error(`${basename(file)} does not match its sha256 file. It was not restored.`);
  if (checksum === "missing") log(`${basename(file)} has no sha256 file; it cannot be checked.`);

  if (checked.intoLive) {
    if (!process.stdin.isTTY) throw new NotRun("--into-live needs a person at a terminal to type the database name. Nothing was restored.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await rl.question(
      `This overwrites the LIVE database "${target.database}" with ${basename(file)}. Stop the web, worker and scheduler first.\nType the database name to continue: `,
    );
    rl.close();
    if (!confirmationMatches(typed, target.database)) throw new NotRun("The name did not match. Nothing was restored.");
  }

  const client = await connect(checked.targetUrl);
  let serverMajor;
  try {
    serverMajor = await serverMajorOf(client);
  } finally {
    await client.end().catch(() => {});
  }
  requireTools(["pg_restore"], serverMajor);
  const clean = checked.clean || checked.intoLive;
  if (!clean && (await hasUserTables(checked.targetUrl))) {
    throw new NotRun(`"${target.database}" already has tables. Restore into an empty database, or pass --clean to replace what it has.`);
  }
  const started = Date.now();
  await runTool("pg_restore", [...restoreArgs(checked.targetUrl, clean), file], checked.targetUrl);
  log(`Restored ${basename(file)} into "${target.database}" in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  log("Next: run `DATABASE_URL=<that database> npm run db:migrate` to apply any migration newer than the backup.");
}

/**
 * Runs scripts/migrate.mjs against a database and reads how many files it applied.
 * @param {string} url
 * @returns {Promise<{ ok: boolean, applied: number | null, detail: string }>}
 */
function migrateInto(url) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts", "migrate.mjs")], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk.toString()));
    child.stderr.on("data", (chunk) => (out += chunk.toString()));
    child.on("close", (code) => {
      if (code !== 0) return resolvePromise({ ok: false, applied: null, detail: out.trim().split("\n").slice(-2).join(" | ") });
      const applied = (out.match(/\[migrate\] applied /g) ?? []).length;
      resolvePromise({ ok: true, applied, detail: out.trim().split("\n").pop() ?? "" });
    });
  });
}

/** @param {string[]} argv */
async function drill(argv) {
  const url = databaseUrlOrNotRun();
  const named = argv.filter((arg) => !arg.startsWith("--"));
  let file;
  if (named.length) {
    file = resolve(process.cwd(), named[0]);
  } else {
    const newest = existsSync(BACKUP_DIR) ? backupsNewestFirst(await readdir(BACKUP_DIR))[0] : undefined;
    if (!newest) throw new NotRun("There is no backup in backups/. Run `npm run db:backup` first.");
    file = join(BACKUP_DIR, newest);
  }
  if (!existsSync(file)) throw new NotRun(`No backup at ${file}.`);

  const source = await connect(url);
  const scratch = scratchDatabaseName(new Date());
  const scratchUrl = withDatabase(url, scratch);
  let created = false;
  let dropped = false;
  /** @type {{ pass: boolean, text: string } | null} */
  let report = null;
  try {
    requireTools(["pg_restore"], await serverMajorOf(source));
    const checksum = await verifyChecksum(file);
    const sizeBytes = (await stat(file)).size;

    /** @type {Record<string, number | null> | null} */
    let atBackup = null;
    if (existsSync(file + COUNTS_EXT)) {
      const parsed = JSON.parse(await readFile(file + COUNTS_EXT, "utf8"));
      if (parsed && typeof parsed.tables === "object" && parsed.tables) atBackup = parsed.tables;
    }
    const tables = atBackup ? Object.keys(atBackup) : await largestTables(source, DRILL_TABLES);

    let restoreError = null;
    let restoreSeconds = null;
    /** @type {{ ok: boolean, applied: number | null, detail: string }} */
    let migrate = { ok: false, applied: null, detail: "not run: the restore did not finish" };
    /** @type {Map<string, number | null>} */
    let restored = new Map();
    if (checksum === "mismatch") {
      restoreError = "not attempted: checksum mismatch";
    } else {
      try {
        await source.query(`create database ${quoteIdent(scratch)}`);
      } catch (error) {
        throw new NotRun(
          `Could not create the scratch database (${error instanceof Error ? error.message : error}). The drill needs a role that may CREATE DATABASE on this server.`,
        );
      }
      created = true;
      const started = Date.now();
      try {
        await runTool("pg_restore", [...restoreArgs(scratchUrl), file], scratchUrl);
        restoreSeconds = (Date.now() - started) / 1000;
      } catch (error) {
        restoreError = error instanceof Error ? error.message : String(error);
      }
      if (!restoreError) {
        migrate = await migrateInto(scratchUrl);
        const target = await connect(scratchUrl);
        try {
          restored = await countRows(target, tables);
        } finally {
          await target.end().catch(() => {});
        }
      }
    }
    const sourceNow = await countRows(source, tables);
    // Without a restore there is nothing to compare: the report says why it failed instead of listing every table as missing.
    const rows = restoreError ? [] : judgeCounts(
      tables.map((table) => ({
        table,
        atBackup: atBackup ? (atBackup[table] ?? null) : null,
        restored: restored.get(table) ?? null,
        sourceNow: sourceNow.get(table) ?? null,
      })),
    );

    if (created) {
      await source.query(`drop database if exists ${quoteIdent(scratch)} with (force)`);
      dropped = true;
    }
    report = formatDrillReport({
      backup: basename(file),
      sizeBytes,
      checksum,
      scratch,
      dropped: created ? dropped : null,
      restoreSeconds,
      restoreError,
      migrate,
      rows,
      countsSource: atBackup ? "snapshot" : "live",
    });
  } finally {
    if (created && !dropped) {
      await source.query(`drop database if exists ${quoteIdent(scratch)} with (force)`).then(
        () => log(`Dropped the scratch database ${scratch}.`),
        () => log(`Could not drop the scratch database ${scratch}. Drop it by hand.`),
      );
    }
    await source.end().catch(() => {});
  }
  if (!report) throw new Error("The drill ended without a report.");
  console.log(report.text);
  if (!report.pass) process.exitCode = 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "backup") return backup();
  if (command === "restore") return restore(rest);
  if (command === "drill") return drill(rest);
  throw new NotRun("Usage: node scripts/backup.mjs backup | restore <file> [--clean] [--into-live] | drill [<file>]");
}

main().catch((error) => {
  if (error instanceof NotRun) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(`[backup] failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
