// The asset cache (Bible 10.4). The key is assetCacheKey(spec, providerId), a sha256 over the model class, the normalised
// prompt, references, frames, duration, seed and provider. The cache is per workspace (Bible 5.2): a key from one tenant is
// never a hit for another. A hit returns the stored asset at $0 and is recorded as a hit (no ledger row: nothing was paid).

export type CachedAsset = {
  workspaceId: string;
  cacheKey: string;
  providerId: string;
  modelClass: string;
  uri: string;
  /** What the first call cost. A hit saves this much. */
  costUsd: number;
  mediaType: string | null;
  storedAt: string;
};

export type CacheHit = {
  workspaceId: string;
  cacheKey: string;
  providerId: string;
  requestId: string;
  shotId: string;
  at: string;
  savedUsd: number;
};

export interface AssetCache {
  get(workspaceId: string, cacheKey: string): Promise<CachedAsset | null>;
  /** Stores a validated asset. The first write wins: artifacts are immutable (Bible 5.2). Returns what is stored. */
  put(asset: CachedAsset): Promise<CachedAsset>;
  recordHit(hit: CacheHit): Promise<void>;
  hits(workspaceId: string): Promise<CacheHit[]>;
}

export function memoryAssetCache(): AssetCache {
  const assets = new Map<string, CachedAsset>();
  const hitLog: CacheHit[] = [];
  const slot = (workspaceId: string, cacheKey: string) => `${workspaceId}\u0000${cacheKey}`;
  return {
    async get(workspaceId, cacheKey) {
      const found = assets.get(slot(workspaceId, cacheKey));
      return found ? structuredClone(found) : null;
    },
    async put(asset) {
      const key = slot(asset.workspaceId, asset.cacheKey);
      const existing = assets.get(key);
      if (existing) return structuredClone(existing);
      assets.set(key, structuredClone(asset));
      return structuredClone(asset);
    },
    async recordHit(hit) {
      hitLog.push(structuredClone(hit));
    },
    async hits(workspaceId) {
      return hitLog.filter((hit) => hit.workspaceId === workspaceId).map((hit) => structuredClone(hit));
    },
  };
}
