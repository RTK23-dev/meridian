import type { Sql } from "../learning/store.ts";

/**
 * The ad account a brand saved for one platform on Connected accounts, or "" when none is saved. The performance sync and the publish
 * path both read the account here, so a deployment's environment variable never decides which account a brand's ads go to (review
 * 2026-10-22, item 11).
 */
export async function savedAdAccountId(sql: Sql, organizationId: string, brandId: string, platform: string): Promise<string> {
  const rows = await sql<{ external_account_id: string | null }>`
    select external_account_id from platform_accounts
    where organization_id = ${organizationId} and brand_id = ${brandId} and platform = ${platform}
      and account_type = 'ad_account'
      and external_account_id is not null and external_account_id <> ''
    limit 1
  `;
  return rows[0]?.external_account_id?.trim() ?? "";
}

/** The platform each publishing provider's saved ad account is stored under on Connected accounts. */
export const AD_ACCOUNT_PLATFORM = { meta: "meta_ads", google: "google_ads", tiktok: "tiktok_ads" } as const;

/** The name a person sees for each provider's ad account, in the messages that say it is missing. */
export const AD_ACCOUNT_LABEL = { meta: "Meta", google: "Google Ads", tiktok: "TikTok" } as const;
