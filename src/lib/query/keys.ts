export const qk = {
  workspace: (userId: string) => ["workspace", userId] as const,
  brand: (brandId: string) => ["brand", brandId] as const,
  machine: (brandId: string) => ["machine", brandId] as const,
  intelligence: (brandId: string) => ["intelligence", brandId] as const,
  studio: (brandId: string) => ["studio", brandId] as const,
  opportunities: (brandId: string) => ["opportunities", brandId] as const,
  market: (brandId: string) => ["market", brandId] as const,
  reviews: (brandId: string) => ["reviews", brandId] as const,
  library: (brandId: string) => ["library", brandId] as const,
  trace: (brandId: string, creativeId?: string) => creativeId ? ["trace", brandId, creativeId] as const : ["trace", brandId] as const,
  assets: (brandId: string) => ["assets", brandId] as const,
  learning: (brandId: string) => ["learning", brandId] as const,
  calibration: (brandId: string) => ["calibration", brandId] as const,
  integrations: (organizationId: string) => ["integrations", organizationId] as const,
};

export function userScopedQueryKey(userId: string | null | undefined, key: readonly unknown[]) {
  return ["user", userId ?? "signed-out", ...key] as const;
}
