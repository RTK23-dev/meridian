// Concurrency buckets (Bible 10.4): one bucket per provider, sized by its class from config/thresholds.ts. A full bucket
// means the job stays queued for the caller; it does not spin here. The in-memory store is for tests and single-process use;
// the Postgres store is eng-pipeline's.

export type BucketClass = "video" | "image" | "tts";

/** The class whose limit applies to a model class. Lip-sync and avatar work are video jobs. */
export function bucketClassFor(modelClass: string): BucketClass {
  if (modelClass.startsWith("image.")) return "image";
  if (modelClass === "tts") return "tts";
  return "video";
}

export interface BucketStore {
  /** Takes one slot when fewer than `limit` are in use. Returns false, and takes nothing, when the bucket is full. */
  tryAcquire(bucketId: string, limit: number): Promise<boolean>;
  release(bucketId: string): Promise<void>;
  inFlight(bucketId: string): Promise<number>;
}

export function memoryBucketStore(): BucketStore {
  const inUse = new Map<string, number>();
  return {
    async tryAcquire(bucketId, limit) {
      const current = inUse.get(bucketId) ?? 0;
      if (current >= limit) return false;
      inUse.set(bucketId, current + 1);
      return true;
    },
    async release(bucketId) {
      const current = inUse.get(bucketId) ?? 0;
      inUse.set(bucketId, Math.max(0, current - 1));
    },
    async inFlight(bucketId) {
      return inUse.get(bucketId) ?? 0;
    },
  };
}
