/**
 * Lease recovery for a real Postgres (`DATABASE_URL`).
 * It does not mark work succeeded. Job handlers run in the application server,
 * which can see the same database. The preview database is in-memory, so this
 * process exits instead of attaching to an empty second database.
 */
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.log("[worker] DATABASE_URL is not set. The web process runs the worker against the in-memory database.");
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

async function recover() {
  const result = await pool.query(
    `update jobs
     set status = case when attempts >= max_attempts then 'dead' else 'retry' end,
         last_error = 'Lease expired before the worker finished.',
         lease_until = null,
         updated_at = now()
     where status = 'running' and lease_until is not null and lease_until < now()`,
  );
  if (result.rowCount) console.log(`[worker] recovered ${result.rowCount} expired lease(s). Handlers run in the app server.`);
}

console.log("[worker] recovering expired leases only. No provider calls are made from this process.");
await recover();
setInterval(() => {
  void recover().catch((error) => console.error("[worker]", error instanceof Error ? error.message : error));
}, 15000);
