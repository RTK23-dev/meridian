import pg from "pg";
import { tickSqlJobs, requestWorkerStop } from "../src/lib/meridian/jobs/sql-worker.ts";
import { createPoolSql } from "../src/lib/meridian/learning/pool-sql.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("[worker] DATABASE_URL is required. This process does not attach to the web server's memory.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  ssl: databaseUrl.includes("sslmode=disable") ? false : undefined,
});

// The same Sql the web server uses on Postgres: it provides transactions, so jobs that write several rows run atomically.
const sql = createPoolSql(pool);
let timer: NodeJS.Timeout | null = null;
let running = false;
let shutdownRequested = false;

async function beat(detail: string) {
  await sql`
    insert into process_heartbeats (name, beat_at, detail)
    values ('worker', now(), ${detail})
    on conflict (name) do update set beat_at = now(), detail = excluded.detail
  `;
}

async function loop() {
  if (running) return;
  running = true;
  try {
    const result = await tickSqlJobs(sql);
    await beat(result.stopped ? "stopping" : `claimed:${result.claimed}`);
    if (result.stopped) {
      await pool.end();
      process.exit(0);
    }
  } catch (error) {
    console.error("[worker]", error instanceof Error ? error.message : error);
  } finally {
    running = false;
    if (shutdownRequested) {
      const retry = setTimeout(() => void loop(), 1000);
      retry.unref();
    }
  }
}

function shutdown() {
  shutdownRequested = true;
  requestWorkerStop();
  if (timer) clearInterval(timer);
  void loop();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log("[worker] executing jobs");
void loop();
timer = setInterval(() => { void loop(); }, 5000);
timer.unref();
