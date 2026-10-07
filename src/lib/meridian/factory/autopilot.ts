export const FACTORY_LEVELS = [0, 1, 2, 3] as const;
export type FactoryLevel = (typeof FACTORY_LEVELS)[number];

export const FACTORY_LEVEL_LABELS: Record<FactoryLevel, string> = {
  0: "Suggest",
  1: "Produce",
  2: "Stage",
  3: "Run",
};

export const FACTORY_LEVEL_DETAIL: Record<FactoryLevel, string> = {
  0: "Finds winners and trends, proposes templates. People do the rest.",
  1: "Also makes the variants and runs every gate. People review.",
  2: "Also uploads approved variants as paused campaigns.",
  3: "Also launches and shifts budget, only inside owner-set caps. Opt-in per brand.",
};

export function parseFactoryLevel(value: unknown): FactoryLevel | null {
  const number = typeof value === "number" ? value : Number(value);
  if (number === 0 || number === 1 || number === 2 || number === 3) return number;
  return null;
}

export function canRunStage(level: FactoryLevel, stage: "discover" | "produce" | "stage" | "run"): boolean {
  if (stage === "discover") return true;
  if (stage === "produce") return level >= 1;
  if (stage === "stage") return level >= 2;
  return level >= 3;
}

export type SpendCap = {
  dailyCents: number;
  totalCents: number;
};

export function assertSpendCap(cap: SpendCap): SpendCap {
  if (!Number.isInteger(cap.dailyCents) || cap.dailyCents < 0) throw new Error("Daily spend cap must be a whole number of cents.");
  if (!Number.isInteger(cap.totalCents) || cap.totalCents < 0) throw new Error("Total spend cap must be a whole number of cents.");
  if (cap.dailyCents > cap.totalCents && cap.totalCents > 0) {
    throw new Error("Daily spend cap cannot exceed the total cap.");
  }
  return cap;
}

export function spendWithinCap(spentCents: number, cap: SpendCap): boolean {
  if (spentCents < 0) return false;
  if (cap.totalCents > 0 && spentCents >= cap.totalCents) return false;
  return true;
}

export type MetaRoundTripReceipt = {
  ok: boolean;
  hasConfirmedVideoUpload: boolean;
  hasPausedCampaign: boolean;
  hasSyncedPerformance: boolean;
  missing: string[];
};

export async function checkMetaRoundTripReceipt(
  sql: import("../learning/store.ts").Sql,
  brandId: string,
): Promise<MetaRoundTripReceipt> {
  const uploads = await sql<{ count: string }>`
    select count(*) as count from meta_video_uploads
    where brand_id = ${brandId} and status = 'confirmed' and external_id != ''
  `;
  const hasConfirmedVideoUpload = Number(uploads[0]?.count ?? 0) > 0;

  const campaigns = await sql<{ count: string }>`
    select count(*) as count from provider_objects
    where brand_id = ${brandId} and provider = 'meta' and object_type in ('campaign', 'ad', 'adset') and status = 'stored'
  `;
  const hasPausedCampaign = Number(campaigns[0]?.count ?? 0) > 0;

  const performance = await sql<{ count: string }>`
    select count(*) as count from performance_observations
    where brand_id = ${brandId} and (source = 'meta' or platform = 'meta')
  `;
  const hasSyncedPerformance = Number(performance[0]?.count ?? 0) > 0;

  const missing: string[] = [];
  if (!hasConfirmedVideoUpload) missing.push("confirmed Meta MP4 video upload");
  if (!hasPausedCampaign) missing.push("paused Meta campaign creation receipt");
  if (!hasSyncedPerformance) missing.push("synced Meta performance observations");

  const ok = hasConfirmedVideoUpload && hasPausedCampaign && hasSyncedPerformance;
  return {
    ok,
    hasConfirmedVideoUpload,
    hasPausedCampaign,
    hasSyncedPerformance,
    missing,
  };
}

export async function assertAutopilotLevelAllowed(
  sql: import("../learning/store.ts").Sql,
  brandId: string,
  level: FactoryLevel,
): Promise<void> {
  if (level <= 1) return;
  const receipt = await checkMetaRoundTripReceipt(sql, brandId);
  if (!receipt.ok) {
    throw new Error(
      `Autopilot level ${level} (${FACTORY_LEVEL_LABELS[level]}) requires a verified Meta test-account round trip. Missing evidence: ${receipt.missing.join(", ")}. Missing evidence is review, not a pass.`,
    );
  }
}

