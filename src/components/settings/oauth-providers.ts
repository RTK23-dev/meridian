/** The account providers an integration card can list, and the ones that connect through an OAuth consent screen. */
export type AccountProvider = "meta" | "tiktok" | "google" | "ad_library";
export type OAuthProvider = Extract<AccountProvider, "meta" | "tiktok" | "google">;

const OAUTH: ReadonlySet<string> = new Set<OAuthProvider>(["meta", "tiktok", "google"]);

/** Only the three OAuth providers get Connect and Refresh token. Meta Ad Library is read without a consent screen. */
export function isOAuthProvider(provider: string): provider is OAuthProvider {
  return OAUTH.has(provider);
}
