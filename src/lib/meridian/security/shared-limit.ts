/**
 * A sliding window counted in Postgres, approximated by the current bucket plus the
 * overlapping part of the previous one. Two processes updating the same row take the
 * row lock, so the count is the deployment's count, not one process's. A burst at the
 * end of one bucket cannot take a full new allowance at the start of the next.
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
  const startMs = Math.floor(now / windowMs) * windowMs;
  const start = new Date(startMs).toISOString();
  const previous = new Date(startMs - windowMs).toISOString();
  const weight = (windowMs - (now - startMs)) / windowMs;
  const cutoff = new Date(now - windowMs * 3).toISOString();
  await query(`delete from rate_limit_windows where window_start < $1`, [cutoff]);
  const inserted = await query(
    `with gate as (
       select (
         coalesce((
           select hits from rate_limit_windows
           where bucket = $1 and window_start = $3::timestamptz
         ), 0) * $4::float8
       ) < $5::int as open
     ),
     bumped as (
       insert into rate_limit_windows (bucket, window_start, hits)
       select $1, $2::timestamptz, 1 from gate where open
       on conflict (bucket, window_start) do update
         set hits = rate_limit_windows.hits + 1
         where (
           coalesce((
             select hits from rate_limit_windows previous
             where previous.bucket = excluded.bucket and previous.window_start = $3::timestamptz
           ), 0) * $4::float8 + rate_limit_windows.hits
         ) < $5::int
       returning hits
     )
     select hits from bumped`,
    [bucket, start, previous, weight, limit],
  );
  const hits = Number(inserted.rows[0]?.hits ?? 0);
  return hits > 0;
}
