// Seeds the release acceptance's two uncertain holds into a local embedded database, and resets them when they were released by an
// earlier run. Run it while the dev server is stopped: the embedded database takes one process at a time.
//
//   node scripts/release-acceptance/seed-holds.mjs <data directory>
//
// The owner account must already exist in that directory (docs/RELEASE_ACCEPTANCE.md). It sends no provider request.

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("Give the data directory: node scripts/release-acceptance/seed-holds.mjs <data directory>");
const email = process.env.ACCEPTANCE_EMAIL ?? "acceptance-owner@example.com";
const UNCERTAIN_ERROR = "The provider did not answer before the time limit, so the call may have been billed.";

const db = new PGlite(dataDir, { extensions: { vector } });
await db.waitReady;
try {
  const found = await db.query(
    `select m.organization_id as org from memberships m join "user" u on u.id = m.user_id where u.email = $1 and m.role = 'owner' limit 1`,
    [email],
  );
  const org = found.rows[0]?.org;
  if (!org) throw new Error(`No owner membership for ${email} in ${dataDir}. Create the account first (docs/RELEASE_ACCEPTANCE.md).`);
  const holds = [
    ["mr_acceptance_hold_1", "creative_script", "anthropic/claude-haiku-5.5", "brief_acceptance_1", 0.042, "2 hours"],
    ["mr_acceptance_hold_2", "research_analysis", "google/gemini-2.5-flash", "source_acceptance_2", 0.118, "1 hour"],
  ];
  for (const [id, operation, model, inputRef, estimate, ago] of holds) {
    await db.query(`delete from generation_hold_releases where model_run_id = $1`, [id]);
    await db.query(`update model_runs set status = 'uncertain', error = $2 where id = $1`, [id, UNCERTAIN_ERROR]);
    await db.query(
      `insert into model_runs (id, organization_id, brand_id, correlation_id, operation, provider, model, prompt_id, prompt_version, input_ref, output, latency_ms, status, error, estimate_usd, created_at)
       values ($1, $2, null, $3, $4, 'openrouter', $5, $4, '1', $6, '', 0, 'uncertain', $7, $8, now() - ($9)::interval)
       on conflict (id) do nothing`,
      [id, org, `corr_${id}`, operation, model, inputRef, UNCERTAIN_ERROR, estimate, ago],
    );
  }
  const count = await db.query(`select count(*)::int as n from model_runs where organization_id = $1 and status = 'uncertain'`, [org]);
  console.log(`Seeded organization ${org}: ${count.rows[0].n} uncertain hold(s).`);
} finally {
  await db.close();
}
