import pg from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("[scheduler] DATABASE_URL is required. The scheduler only enqueues. It does not execute jobs.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  ssl: databaseUrl.includes("sslmode=disable") ? false : undefined,
});

async function tick() {
  await pool.query(
    `insert into process_heartbeats (name, beat_at, detail)
     values ('scheduler', now(), 'enqueue-only')
     on conflict (name) do update set beat_at = now(), detail = excluded.detail`,
  );
  const due = await pool.query<{
    id: string;
    organization_id: string;
    brand_id: string | null;
    job_type: string;
    next_run: Date;
    every_seconds: number;
  }>(
    `select id, organization_id, brand_id, job_type, next_run, every_seconds
     from job_schedules
     where enabled = true and next_run <= now()`,
  );
  for (const schedule of due.rows) {
    const stamp = new Date(schedule.next_run).toISOString();
    const key = `schedule:${schedule.id}:${stamp}`;
    await pool.query(
      `insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload)
       values ($1, $2, $3, $4, $5, 'queued', $6)
       on conflict (organization_id, idempotency_key) do nothing`,
      [crypto.randomUUID(), schedule.organization_id, schedule.brand_id, schedule.job_type, key, JSON.stringify({ scheduleId: schedule.id, organizationId: schedule.organization_id })],
    );
    await pool.query(
      `update job_schedules
       set next_run = next_run + ($2 * interval '1 second')
       where id = $1 and next_run <= now()`,
      [schedule.id, schedule.every_seconds],
    );
  }
}

console.log("[scheduler] enqueue only");
await tick();
setInterval(() => {
  void tick().catch((error) => console.error("[scheduler]", error instanceof Error ? error.message : error));
}, 15000);
