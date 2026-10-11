/**
 * Google Drive Authentication Service
 *
 * Handles OAuth 2.0 refresh flow and Service Account JWT for the Google Drive API. Drive is the artifact store only: it
 * holds artifact and export bytes. Postgres holds every record about them. The access token is kept in memory for this
 * process and is never written to the database.
 *
 * This is separate from the Google sign-in on the Integrations screen (oauth/flow.server.ts). That flow requests the
 * Google Ads scope with GOOGLE_ADS_CLIENT_ID and stores its token in provider_secrets, so it does not authorize Drive.
 * Never fabricates tokens when credentials are unset.
 */

export type GoogleAuthStatus = {
  configured: boolean;
  type: "oauth_refresh" | "service_account" | "none";
  detail: string;
};

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

/** The environment the auth status reads. process.env satisfies it; tests pass a plain object. */
type AuthEnv = { [key: string]: string | undefined };

let cachedAuthToken: CachedToken | null = null;

/** Drops the cached access token, so the next request mints one. Used after Drive answers 401. */
export function invalidateGoogleDriveAccessToken(): void {
  cachedAuthToken = null;
}

export function getGoogleDriveAuthStatus(env: AuthEnv = process.env): GoogleAuthStatus {
  if (env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim()) {
    return {
      configured: true,
      type: "service_account",
      detail: "Google Service Account key is configured.",
    };
  }

  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = env.GOOGLE_REFRESH_TOKEN?.trim();

  if (clientId && clientSecret && refreshToken) {
    return {
      configured: true,
      type: "oauth_refresh",
      detail: "Google OAuth 2.0 refresh credentials are configured.",
    };
  }

  return {
    configured: false,
    type: "none",
    detail: "Neither GOOGLE_SERVICE_ACCOUNT_KEY nor GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN is set. Google Drive is not connected.",
  };
}

/**
 * Returns a valid access token for Google Drive API, or null if not configured.
 */
export async function getGoogleDriveAccessToken(): Promise<string | null> {
  const status = getGoogleDriveAuthStatus();
  if (!status.configured) return null;

  const now = Date.now();
  if (cachedAuthToken && cachedAuthToken.expiresAt > now + 60_000) {
    return cachedAuthToken.accessToken;
  }

  if (status.type === "oauth_refresh") {
    const clientId = process.env.GOOGLE_CLIENT_ID!.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!.trim();
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN!.trim();

    try {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google token refresh failed: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as { access_token: string; expires_in: number };
      cachedAuthToken = {
        accessToken: data.access_token,
        expiresAt: now + (data.expires_in ?? 3600) * 1000,
      };
      return cachedAuthToken.accessToken;
    } catch (err) {
      console.error("[google-auth] Error refreshing OAuth token:", err);
      return null;
    }
  }

  // Service Account flow
  if (status.type === "service_account") {
    try {
      const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!.trim());
      const nowSec = Math.floor(now / 1000);
      const header = { alg: "RS256", typ: "JWT" };
      const claimSet = {
        iss: creds.client_email,
        scope: "https://www.googleapis.com/auth/drive",
        aud: "https://oauth2.googleapis.com/token",
        exp: nowSec + 3600,
        iat: nowSec,
      };

      const crypto = await import("node:crypto");
      const encodeBase64Url = (obj: unknown) =>
        Buffer.from(JSON.stringify(obj)).toString("base64url");

      const unsigned = `${encodeBase64Url(header)}.${encodeBase64Url(claimSet)}`;
      const signer = crypto.createSign("RSA-SHA256");
      signer.update(unsigned);
      const signature = signer.sign(creds.private_key, "base64url");
      const jwt = `${unsigned}.${signature}`;

      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google service account token exchange failed: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as { access_token: string; expires_in: number };
      cachedAuthToken = {
        accessToken: data.access_token,
        expiresAt: now + (data.expires_in ?? 3600) * 1000,
      };
      return cachedAuthToken.accessToken;
    } catch (err) {
      console.error("[google-auth] Error generating service account token:", err);
      return null;
    }
  }

  return null;
}
