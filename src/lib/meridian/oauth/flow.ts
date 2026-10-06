import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sendWithRetry, type Transport } from "../providers/http.ts";

export type OauthProvider = "meta" | "tiktok" | "google";

export function newOauthState(): string {
  return randomBytes(24).toString("hex");
}

export function hashOauthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export function oauthStateMatches(storedHash: string, presented: string): boolean {
  const next = Buffer.from(hashOauthState(presented));
  const prior = Buffer.from(storedHash);
  if (next.length !== prior.length) return false;
  return timingSafeEqual(next, prior);
}

export function authorizationUrl(provider: OauthProvider, input: { state: string; redirectUri: string; env: NodeJS.ProcessEnv }): { url: string } | { error: string } {
  const redirectOk = input.redirectUri.startsWith("https://") || input.redirectUri.startsWith("http://localhost") || input.redirectUri.startsWith("http://127.0.0.1");
  if (!input.state.trim() || !redirectOk) {
    return { error: "OAuth needs a state value and an http://localhost or https redirect URI." };
  }
  if (provider === "meta") {
    const appId = input.env.META_APP_ID?.trim();
    if (!appId) return { error: "META_APP_ID is not configured. No authorization URL was built." };
    const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    url.searchParams.set("client_id", appId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("scope", "ads_management,ads_read");
    return { url: url.toString() };
  }
  if (provider === "tiktok") {
    const appId = input.env.TIKTOK_APP_ID?.trim();
    if (!appId) return { error: "TIKTOK_APP_ID is not configured. No authorization URL was built." };
    const url = new URL("https://business-api.tiktok.com/portal/auth");
    url.searchParams.set("app_id", appId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    return { url: url.toString() };
  }
  const clientId = input.env.GOOGLE_ADS_CLIENT_ID?.trim();
  if (!clientId) return { error: "GOOGLE_ADS_CLIENT_ID is not configured. No authorization URL was built." };
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "https://www.googleapis.com/auth/adwords");
  url.searchParams.set("state", input.state);
  url.searchParams.set("access_type", "offline");
  return { url: url.toString() };
}

export async function exchangeOauthCode(
  provider: OauthProvider,
  input: { code: string; redirectUri: string; env: NodeJS.ProcessEnv },
  transport: Transport,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number | null } | { error: string }> {
  if (!input.code.trim()) return { error: "The provider did not return a code." };
  if (provider === "meta") {
    const url = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    url.searchParams.set("client_id", input.env.META_APP_ID ?? "");
    url.searchParams.set("client_secret", input.env.META_APP_SECRET ?? "");
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("code", input.code);
    const result = await sendWithRetry(transport, { method: "GET", url: url.toString(), headers: {} });
    const token = text(result.json, "access_token");
    if (!result.ok || !token) return { error: "Meta did not return an access token. Nothing was stored." };
    return { accessToken: token, refreshToken: text(result.json, "refresh_token"), expiresIn: numberOrNull(result.json, "expires_in") };
  }
  if (provider === "tiktok") {
    const result = await sendWithRetry(transport, {
      method: "POST",
      url: "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: input.env.TIKTOK_APP_ID ?? "",
        secret: input.env.TIKTOK_APP_SECRET ?? "",
        auth_code: input.code,
      }),
    });
    const data = result.json && typeof result.json === "object" ? (result.json as { data?: unknown }).data : null;
    const token = text(data, "access_token");
    if (!result.ok || !token) return { error: "TikTok did not return an access token. Nothing was stored." };
    return { accessToken: token, refreshToken: text(data, "refresh_token"), expiresIn: numberOrNull(data, "expires_in") };
  }
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.env.GOOGLE_ADS_CLIENT_ID ?? "",
    client_secret: input.env.GOOGLE_ADS_CLIENT_SECRET ?? "",
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: "https://oauth2.googleapis.com/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const token = text(result.json, "access_token");
  if (!result.ok || !token) return { error: "Google did not return an access token. Nothing was stored." };
  return { accessToken: token, refreshToken: text(result.json, "refresh_token"), expiresIn: numberOrNull(result.json, "expires_in") };
}

export function sealSecret(plain: string, keyRaw: string): string | { error: string } {
  if (!keyRaw.trim()) return { error: "TOKEN_ENCRYPTION_KEY is not configured. The token was not stored." };
  const key = createHash("sha256").update(keyRaw).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function openSecret(sealed: string, keyRaw: string): string | { error: string } {
  if (!keyRaw.trim()) return { error: "TOKEN_ENCRYPTION_KEY is not configured." };
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length < 29) return { error: "The stored token could not be read." };
  const key = createHash("sha256").update(keyRaw).digest();
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const encrypted = bytes.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function text(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}

function numberOrNull(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" ? raw : null;
}
