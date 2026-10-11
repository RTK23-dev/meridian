/**
 * The origins Better Auth accepts on credentialed requests (server-only logic, kept pure so it can be tested).
 *
 * Better Auth refuses a POST whose Origin is not in this list, with "Invalid origin" (403). The list has four parts:
 *   - the configured public origin (`BETTER_AUTH_URL`),
 *   - any origins named in `MERIDIAN_TRUSTED_ORIGINS`,
 *   - the loopback origins of the local dev server, outside production only,
 *   - the origin the request itself was sent to. A browser sends its own origin on a same-site request, so this admits the
 *     app on whatever host it is served from. A request from another site carries that site's origin, and is refused.
 */
export type TrustedOriginsInput = {
  baseURL: string;
  extraOrigins: readonly string[];
  localDevOrigins: readonly string[];
  isProduction: boolean;
  requestUrl?: string;
};

export function trustedOriginsFor(input: TrustedOriginsInput): string[] {
  const origins = [input.baseURL, ...input.extraOrigins, ...(input.isProduction ? [] : input.localDevOrigins)];
  if (input.requestUrl) {
    try {
      origins.push(new URL(input.requestUrl).origin);
    } catch {
      /* a request without a usable URL adds nothing, so only the configured origins apply */
    }
  }
  return [...new Set(origins)];
}

/** Parse `MERIDIAN_TRUSTED_ORIGINS`: comma-separated, blanks ignored. */
export function parseTrustedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
