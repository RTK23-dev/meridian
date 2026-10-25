// Checks the database after the browser pass: the release of the first hold was audited with the owner's id and a reason of at least
// ten characters, and the second hold is still uncertain. Run it while the dev server is stopped, with the data directory as argument.
//
//   node scripts/release-acceptance/verify-release.mjs <data directory>

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("Give the data directory: node scripts/release-acceptance/verify-release.mjs <data directory>");
const email = process.env.ACCEPTANCE_EMAIL ?? "acceptance-owner@example.com";

const db = new PGlite(dataDir, { extensions: { vector } });
await db.waitReady;
const failures = [];
try {
  const releases = await db.query(
    `select r.model_run_id, r.reason, u.email from generation_hold_releases r
       join "user" u on u.id = r.actor_id
      where r.model_run_id like 'mr_acceptance_hold_%'`,
  );
  if (releases.rows.length !== 1) failures.push(`expected one audited release, found ${releases.rows.length}`);
  const [release] = releases.rows;
  if (release) {
    if (release.model_run_id !== "mr_acceptance_hold_1") failures.push(`the release names ${release.model_run_id}, not the first hold`);
    if (release.email !== email) failures.push("the release is not attributed to the owner account");
    if (String(release.reason).trim().length < 10) failures.push("the release reason is shorter than ten characters");
  }
  const holds = await db.query(`select id, status from model_runs where id like 'mr_acceptance_hold_%' order by id`);
  const second = holds.rows.find((row) => row.id === "mr_acceptance_hold_2");
  if (second?.status !== "uncertain") failures.push("the second hold is no longer uncertain");
} finally {
  await db.close();
}
for (const failure of failures) console.error(`FAIL ${failure}`);
if (failures.length === 0) console.log("VERIFIED the audited release and the untouched second hold.");
process.exitCode = failures.length ? 1 : 0;
