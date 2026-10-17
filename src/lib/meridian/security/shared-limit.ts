/**
 * A fixed window counted in Postgres. Two processes updating the same row take
 * the row lock, so the count is the deployment's count, not one process's.
 * The in-memory limiter remains the path when DATABASE_URL is unset.
 */

export type WindowQuery = (sql: string, params: unknown[]) => Promise<{ rows: Array<{ hits?: number }> }>;

export async function consumeWindow(
  query: WindowQuery,
  bucket: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  const start = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
  const cutoff = new Date(now - windowMs * 3).toISOString();
  await query(`delete from rate_limit_windows where window_start < $1`, [cutoff]);
  const inserted = await query(
    `insert into rate_limit_windows (bucket, window_start, hits)
     values ($1, $2::timestamptz, 1)
     on conflict (bucket, window_start) do update set hits = rate_limit_windows.hits + 1
     returning hits`,
    [bucket, start],
  );
  const hits = Number(inserted.rows[0]?.hits ?? 0);
  return hits > 0 && hits <= limit;
}
