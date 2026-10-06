import pg from "pg";
import { tickSqlJobs, requestWorkerStop } from "../src/lib/meridian/jobs/sql-worker.ts";
import type { Sql } from "../src/lib/meridian/learning/store.ts";

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

function sqlClient(): Sql {
  const sql = (async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ""}`;
    const result = await pool.query(text, values);
    return result.rows as T[];
  }) as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
    const result = await pool.query(text, params);
    return result.rows as T[];
  };
  return sql;
}

const sql = sqlClient();
let timer: NodeJS.Timeout | null = null;
let running = false;

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
  }
}

function shutdown() {
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
