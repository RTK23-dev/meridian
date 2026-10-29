// Seeds three finished discovery runs for the acceptance brand, one per outcome a first-time person meets: new examples, a run where every
// example was already stored, and a page the site's robots.txt did not allow. They are stored states, and no page is fetched: a local
// address is refused by design, and the acceptance sends no request to a live site. The real read is covered by the server tests.
// Run it while the dev server is stopped:  node scripts/release-acceptance/seed-first-run.mjs <data directory>

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("Give the data directory: node scripts/release-acceptance/seed-first-run.mjs <data directory>");
const BRAND_NAME = "Acceptance Brand";
const ROBOTS = "This site's robots.txt does not allow MeridianBot to read this page, so the page was not read.";

const db = new PGlite(dataDir, { extensions: { vector } });
await db.waitReady;
try {
  const brand = (await db.query(`select id, organization_id as org from brands where name = $1 and deleted_at is null limit 1`, [BRAND_NAME])).rows[0];
  if (!brand) throw new Error(`No brand named ${BRAND_NAME} in ${dataDir}. Create it first.`);
  const ran = (seed, itemsFound, seenBefore) => ({ adapterId: "website", seed, status: "ran", itemsFound, seenBefore, sourceStatus: "HEALTHY" });
  const unused = (adapterId, seed) => ({ adapterId, seed, status: "not_supported", reason: `"${seed}" names a page, which is read directly. ${adapterId} searches by phrase, so no search is run for it.` });
  const runs = [
    ["dr_accept_new", "completed", "https://shop.acceptance.example/new", { discoveredUrls: 3, seenBefore: 2, sources: [ran("https://shop.acceptance.example/new", 3, 2)] }, "3 minutes"],
    ["dr_accept_dup", "completed", "https://shop.acceptance.example/same", { discoveredUrls: 0, seenBefore: 5, sources: [ran("https://shop.acceptance.example/same", 0, 5), unused("youtube", "https://shop.acceptance.example/same"), unused("tiktok", "https://shop.acceptance.example/same")] }, "2 minutes"],
    ["dr_accept_blocked", "blocked", "https://www.instagram.com/p/acceptance/", { discoveredUrls: 0, seenBefore: 0, sources: [{ adapterId: "website", seed: "https://www.instagram.com/p/acceptance/", status: "failed", reason: ROBOTS }] }, "1 minute"],
  ];
  for (const [id, status, seed, progress, ago] of runs) {
    await db.query(`delete from discovery_runs where id = $1`, [id]);
    await db.query(
      `insert into discovery_runs (id, organization_id, brand_id, scope, status, seeds, progress, started_at, completed_at)
       values ($1, $2, $3, 'scrape_page', $4, $5::jsonb, $6::jsonb, now() - ($7)::interval, now() - ($7)::interval)`,
      [id, brand.org, brand.id, status, JSON.stringify([seed]), JSON.stringify({ pagesCrawled: 1, discoveredCards: 0, ...progress }), ago],
    );
  }
  console.log(`Seeded ${runs.length} discovery runs for ${BRAND_NAME}.`);

  // A reusable source draft for "Create video variations": an instruction, a reference video record and one Market research record. They are
  // stored rows only. No file is uploaded, no page is read and no video is started.
  const source = "cf_accept_source";
  await db.query(`delete from content_factory_sessions where id = $1`, [source]);
  await db.query(
    `insert into content_factory_sessions (id, organization_id, brand_id, title, status, max_seconds, language, priority) values ($1, $2, $3, 'Acceptance reference draft', 'draft', 30, 'en', 'normal')`,
    [source, brand.org, brand.id],
  );
  await db.query(`insert into content_factory_messages (id, organization_id, session_id, text) values ($1, $2, $3, $4)`, [`${source}_m1`, brand.org, source, "Make a calm product demo in the brand voice."]);
  await db.query(`insert into content_factory_messages (id, organization_id, session_id, text) values ($1, $2, $3, '')`, [`${source}_m2`, brand.org, source]);
  await db.query(
    `insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, purpose, file_name, storage_key, media_type, byte_size, sha256)
     values ($1, $2, $3, $4, 'file', 'reference_video', 'reference.mp4', 'acceptance/reference.mp4', 'video/mp4', 2048, $5)`,
    [`${source}_ref`, brand.org, source, `${source}_m2`, "b".repeat(64)],
  );
  await db.query(
    `insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, source_page, source_brand_id, source_record_id, snapshot)
     values ($1, $2, $3, $4, 'source', 'market', $5, 'acceptance_record', 'A competitor opens on the problem.')`,
    [`${source}_mkt`, brand.org, source, `${source}_m2`, brand.id],
  );
  console.log("Seeded one reusable source draft.");
} finally {
  await db.close();
}
