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
