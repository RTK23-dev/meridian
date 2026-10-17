export type AccountOauthProvider = "meta" | "google" | "tiktok";

export type OauthClientReadiness = { provider: AccountOauthProvider; ready: boolean; missing: string[] };

const REQUIRED: Record<AccountOauthProvider, readonly string[]> = {
  meta: ["META_APP_ID", "META_APP_SECRET"],
  google: ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET"],
  tiktok: ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"],
};

/**
 * Whether the deployment has the client id and secret each account sign-in needs. The result names the settings that are
 * missing. It never returns a value, so it is safe to show.
 */
export function oauthClientReadiness(env: NodeJS.ProcessEnv): Record<AccountOauthProvider, OauthClientReadiness> {
  const readinessFor = (provider: AccountOauthProvider): OauthClientReadiness => {
    const missing = REQUIRED[provider].filter((name) => !env[name]?.trim());
    return { provider, ready: missing.length === 0, missing: [...missing] };
  };
  return { meta: readinessFor("meta"), google: readinessFor("google"), tiktok: readinessFor("tiktok") };
}
