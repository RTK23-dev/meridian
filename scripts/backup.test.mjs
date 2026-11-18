import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_KEEP,
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
  parseBackupFileName,
  parseChecksumLine,
  parseKeep,
  quoteIdent,
  sameDatabase,
  scratchDatabaseName,
  selectForDeletion,
  withDatabase,
} from "./backup-lib.mjs";

const LIVE = "postgres://app:s3cret@db.internal:5432/meridian?sslmode=require";

test("a backup is named by database and UTC time, and the name parses back", () => {
  const name = backupFileName(new Date("2026-11-18T03:15:09.123Z"), "Meridian-Prod");
  assert.equal(name, "meridian-meridian_prod-20261118T031509Z.dump");
  assert.deepEqual(parseBackupFileName(name), { label: "meridian_prod", stamp: "20261118T031509Z" });
  assert.equal(parseBackupFileName("notes.txt"), null);
  assert.equal(parseBackupFileName(`${name}.sha256`), null);
});

test("backups sort newest first and ignore other files", () => {
  const files = [
    "meridian-db-20261101T000000Z.dump",
    "README",
    "meridian-db-20261103T000000Z.dump",
    "meridian-db-20261103T000000Z.dump.sha256",
    "meridian-db-20261102T000000Z.dump",
  ];
  assert.deepEqual(backupsNewestFirst(files), [
    "meridian-db-20261103T000000Z.dump",
    "meridian-db-20261102T000000Z.dump",
    "meridian-db-20261101T000000Z.dump",
  ]);
});

test("retention deletes only older backups and their sidecars", () => {
  const files = [
    "meridian-db-20261101T000000Z.dump",
    "meridian-db-20261101T000000Z.dump.sha256",
    "meridian-db-20261101T000000Z.dump.counts.json",
    "meridian-db-20261102T000000Z.dump",
    "meridian-db-20261102T000000Z.dump.sha256",
    "meridian-db-20261103T000000Z.dump",
    "keep-me.dump",
  ];
  assert.deepEqual(selectForDeletion(files, 2), [
    "meridian-db-20261101T000000Z.dump",
    "meridian-db-20261101T000000Z.dump.sha256",
    "meridian-db-20261101T000000Z.dump.counts.json",
  ]);
  assert.deepEqual(selectForDeletion(files, 14), []);
  assert.throws(() => selectForDeletion(files, 0));
});

test("BACKUP_KEEP defaults to 14 and refuses anything that is not a whole number from 1 to 1000", () => {
  assert.deepEqual(parseKeep(undefined), { ok: true, keep: DEFAULT_KEEP });
  assert.deepEqual(parseKeep(" "), { ok: true, keep: 14 });
  assert.deepEqual(parseKeep("3"), { ok: true, keep: 3 });
  for (const bad of ["0", "-1", "2.5", "ten", "1001"]) assert.equal(parseKeep(bad).ok, false, bad);
});

test("database identity ignores the password and treats localhost names as one host", () => {
  assert.deepEqual(databaseIdentity(LIVE), { host: "db.internal", port: "5432", database: "meridian", user: "app" });
  assert.equal(databaseIdentity("mysql://x/y"), null);
  assert.equal(databaseIdentity("postgres://x/"), null);
  assert.equal(sameDatabase("postgres://a@localhost/m", "postgres://b:pw@127.0.0.1:5432/m"), true);
  assert.equal(sameDatabase("postgres://a@localhost/m", "postgres://a@localhost/m_restore"), false);
  assert.equal(sameDatabase("not a url", LIVE), true, "an unreadable URL counts as the same, so the check fails closed");
});

test("the client tools get the connection in libpq variables, so no password is on a command line", () => {
  assert.deepEqual(libpqEnv(LIVE), {
    PGHOST: "db.internal",
    PGPORT: "5432",
    PGDATABASE: "meridian",
    PGUSER: "app",
    PGPASSWORD: "s3cret",
    PGSSLMODE: "require",
  });
  assert.equal(databaseIdentity(withDatabase(LIVE, "meridian_drill_x"))?.database, "meridian_drill_x");
  assert.match(scratchDatabaseName(new Date("2026-11-18T03:15:09Z")), /^meridian_drill_20261118t031509z$/);
});

test("restore refuses the live database unless --into-live is passed", () => {
  const base = { databaseUrl: LIVE, restoreUrl: "" };
  assert.equal(checkRestoreArgs({ ...base, args: ["b.dump"] }).ok, false, "no target");
  const same = checkRestoreArgs({ ...base, restoreUrl: "postgres://other:pw@db.internal/meridian", args: ["b.dump"] });
  assert.equal(same.ok, false);
  assert.match(same.ok ? "" : same.error, /live database/);
  const other = checkRestoreArgs({ ...base, restoreUrl: "postgres://app@db.internal/meridian_restore", args: ["b.dump"] });
  assert.equal(other.ok && other.targetUrl, "postgres://app@db.internal/meridian_restore");
  const live = checkRestoreArgs({ ...base, args: ["b.dump", "--into-live"] });
  assert.equal(live.ok && live.intoLive && live.targetUrl === LIVE, true);
  assert.equal(checkRestoreArgs({ ...base, restoreUrl: "postgres://x/y", args: ["b.dump", "--into-live"] }).ok, false);
  assert.equal(checkRestoreArgs({ databaseUrl: "", restoreUrl: "", args: ["b.dump", "--into-live"] }).ok, false);
  assert.equal(checkRestoreArgs({ ...base, args: [] }).ok, false, "no file");
  assert.equal(checkRestoreArgs({ ...base, args: ["a.dump", "b.dump"] }).ok, false, "two files");
  assert.equal(checkRestoreArgs({ ...base, args: ["a.dump", "--force"] }).ok, false, "unknown flag");
});

test("the typed confirmation must be the exact database name", () => {
  assert.equal(confirmationMatches("meridian\n", "meridian"), true);
  assert.equal(confirmationMatches("Meridian", "meridian"), false);
  assert.equal(confirmationMatches("", ""), false);
});

test("checksum sidecars use the sha256sum format", () => {
  const hex = "a".repeat(64);
  assert.equal(checksumLine(hex, "x.dump"), `${hex}  x.dump\n`);
  assert.equal(parseChecksumLine(checksumLine(hex, "x.dump")), hex);
  assert.equal(parseChecksumLine("nope"), null);
});

test("versions and install hints", () => {
  assert.equal(majorVersion("pg_dump (PostgreSQL) 16.4 (Ubuntu 16.4-1)"), 16);
  assert.equal(majorVersion("16.2"), 16);
  assert.equal(majorVersion(""), null);
  assert.match(installHint(16), /postgresql-client-16/);
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
});

test("counts from the backup's snapshot must match exactly; live counts get a tolerance", () => {
  const [exact, off, missing] = judgeCounts([
    { table: "public.jobs", atBackup: 5, restored: 5, sourceNow: 9 },
    { table: "public.brands", atBackup: 5, restored: 4, sourceNow: 5 },
    { table: "public.gone", atBackup: 1, restored: null, sourceNow: 1 },
  ]);
  assert.equal(exact.ok, true);
  assert.equal(off.ok, false);
  assert.equal(missing.ok, false);
  const [near, far] = judgeCounts([
    { table: "a", atBackup: null, restored: 995, sourceNow: 1000 },
    { table: "b", atBackup: null, restored: 900, sourceNow: 1000 },
  ]);
  assert.equal(near.ok, true);
  assert.equal(far.ok, false);
});

test("the drill report passes only when everything held, and says why it failed", () => {
  const base = {
    backup: "meridian-db-20261118T000000Z.dump",
    sizeBytes: 2 * 1024 * 1024,
    checksum: /** @type {const} */ ("ok"),
    scratch: "meridian_drill_x",
    dropped: true,
    restoreSeconds: 1.25,
    restoreError: null,
    migrate: { ok: true, applied: 0, detail: "up to date" },
    rows: judgeCounts([{ table: "public.jobs", atBackup: 3, restored: 3, sourceNow: 3 }]),
    countsSource: /** @type {const} */ ("snapshot"),
  };
  const pass = formatDrillReport(base);
  assert.equal(pass.pass, true);
  assert.match(pass.text, /^Restore drill: PASS/);
  assert.match(pass.text, /public\.jobs\s+3\s+3\s+3\s+ok/);

  const failed = formatDrillReport({ ...base, checksum: "mismatch", restoreError: "not attempted: checksum mismatch", rows: [] });
  assert.equal(failed.pass, false);
  assert.match(failed.text, /FAIL: the backup does not match its sha256 file/);

  const migrateFailed = formatDrillReport({ ...base, migrate: { ok: false, applied: null, detail: "relation x" } });
  assert.equal(migrateFailed.pass, false);
  assert.match(migrateFailed.text, /migrator failed/);

  const notDropped = formatDrillReport({ ...base, dropped: false });
  assert.match(notDropped.text, /NOT dropped/);
  assert.match(formatDrillReport({ ...base, dropped: null }).text, /not created/);
});
