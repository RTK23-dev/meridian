export function createRateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  let calls = 0;
  return {
    allow(key: string, now: number): boolean {
      const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
      if (recent.length === 0) hits.delete(key);
      else hits.set(key, recent);
      // Keep idle keys from accumulating forever in long-lived server processes.
      if (++calls % 128 === 0 || hits.size > 2048) {
        for (const [storedKey, times] of hits) {
          const active = times.filter((time) => now - time < windowMs);
          if (active.length) hits.set(storedKey, active);
          else hits.delete(storedKey);
        }
      }
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}

export const RATE_LIMIT_MESSAGE = "Too many requests. Wait a minute and try again.";

/** Sign-in, password, and OAuth callbacks: 20 attempts / minute per IP. */
export const authLimit = createRateLimit(20, 60_000);
/** Invites and invite accepts: 10 / minute per user. */
export const inviteLimit = createRateLimit(10, 60_000);
/** Uploads and material ingest: 30 / minute per user. */
export const uploadLimit = createRateLimit(30, 60_000);
/** Model, research, and generation calls: 20 / minute per user. */
export const modelLimit = createRateLimit(20, 60_000);

export function refuseIfLimited(
  limiter: { allow: (key: string, now: number) => boolean },
  key: string,
  now = Date.now(),
): void {
  if (!limiter.allow(key, now)) throw new Error(RATE_LIMIT_MESSAGE);
}

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 80);
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 80);
  return "unknown";
}
