/** Which account sign-in, if any, a platform on the Accounts screen starts. Ad accounts use the workspace login. A creator profile does not. */
export type AccountSignInProvider = "meta" | "google" | "tiktok";

export function signInProviderForPlatform(platform: string): AccountSignInProvider | null {
  if (platform === "meta_ads") return "meta";
  if (platform === "google_ads") return "google";
  if (platform === "tiktok_ads") return "tiktok";
  return null;
}

export type SignInReadiness = { ready: boolean; missing: readonly string[] } | undefined;

/**
 * Whether the sign-in button works. Only a workspace admin can start sign-in, and it needs the deployment's client id and secret.
 * When either is missing, the reason names the missing settings, so the disabled button says why.
 */
export function signInState(input: {
  provider: AccountSignInProvider;
  canAdmin: boolean;
  readiness: SignInReadiness;
}): { enabled: boolean; reason: string | null } {
  const name = input.provider === "meta" ? "Meta" : input.provider === "google" ? "Google Ads" : "TikTok";
  if (!input.canAdmin) return { enabled: false, reason: "Only a workspace admin can start sign-in." };
  if (!input.readiness) return { enabled: false, reason: "Checking the sign-in settings for this deployment." };
  if (!input.readiness.ready) {
    return {
      enabled: false,
      reason: `${name} sign-in is off on this deployment. Set ${input.readiness.missing.join(" and ")} to turn it on.`,
    };
  }
  return { enabled: true, reason: null };
}
