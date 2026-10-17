/**
 * A sliding-window limit, held in this process's memory.
 *
 * Used when DATABASE_URL is unset (one local process, and the unit tests).
 * When DATABASE_URL is set, enforceNamedLimit counts the same bucket in
 * rate_limit_windows so a second instance cannot multiply the allowance.
 * A database error is left as a database error. Only a full window throws RateLimitError.
 */
import { consumeWindow, type WindowQuery } from "./shared-limit.ts";

export function createRateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  let calls = 0;
  return {
    allow(key: string, now: number): boolean {
      const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
      if (recent.length === 0) hits.delete(key);
      else hits.set(key, recent);
      // Keep idle keys from accumulating forever in long-lived server processes.
      if (++calls % 128 === 0 || hits.size > 2048) {
        for (const [storedKey, times] of hits) {
          const active = times.filter((time) => now - time < windowMs);
          if (active.length) hits.set(storedKey, active);
          else hits.delete(storedKey);
        }
      }
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}

export const RATE_LIMIT_MESSAGE = "Too many requests. Wait a minute and try again.";

/** A real limit breach. A database failure is a different error and must not be reported as this. */
export class RateLimitError extends Error {
  constructor() {
    super(RATE_LIMIT_MESSAGE);
    this.name = "RateLimitError";
  }
}

export function isRateLimitError(error: unknown): boolean {
  return error instanceof RateLimitError;
}

/** 429 only for a real limit. Any other failure is unavailable, not a lockout. */
export function authFailureResponse(error: unknown): Response {
  if (isRateLimitError(error)) {
    return new Response(JSON.stringify({ message: RATE_LIMIT_MESSAGE }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ message: "Sign-in is temporarily unavailable." }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

/** Sign-in, password, and OAuth callbacks: 20 attempts / minute per route and client (or per targeted account). */
export const authLimit = createRateLimit(20, 60_000);
/** Invites and invite accepts: 10 / minute per user. */
export const inviteLimit = createRateLimit(10, 60_000);
/** Uploads and material ingest: 30 / minute per user. */
export const uploadLimit = createRateLimit(30, 60_000);
/** Model, research, and generation calls: 20 / minute per user. */
export const modelLimit = createRateLimit(20, 60_000);

export function refuseIfLimited(
  limiter: { allow: (key: string, now: number) => boolean },
  key: string,
  now = Date.now(),
): void {
  if (!limiter.allow(key, now)) throw new RateLimitError();
}

const NAMED_LIMITS = {
  auth: authLimit,
  invite: inviteLimit,
  upload: uploadLimit,
  model: modelLimit,
} as const;

const NAMED_SPEC = {
  auth: { limit: 20, windowMs: 60_000 },
  invite: { limit: 10, windowMs: 60_000 },
  upload: { limit: 30, windowMs: 60_000 },
  model: { limit: 20, windowMs: 60_000 },
} as const;

export type NamedLimit = keyof typeof NAMED_LIMITS;

let sharedQuery: WindowQuery | null | undefined;

async function databaseQuery(): Promise<WindowQuery | null> {
  if (sharedQuery !== undefined) return sharedQuery;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    sharedQuery = null;
    return null;
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: url,
    max: 2,
    ssl: url.includes("sslmode=disable") ? false : undefined,
  });
  sharedQuery = async (sql, params) => pool.query(sql, params);
  return sharedQuery;
}

/** Counts against Postgres when DATABASE_URL is set, otherwise against this process. */
export async function enforceNamedLimit(name: NamedLimit, key: string): Promise<void> {
  const query = await databaseQuery();
  if (!query) {
    refuseIfLimited(NAMED_LIMITS[name], key);
    return;
  }
  const spec = NAMED_SPEC[name];
  const allowed = await consumeWindow(query, `${name}:${key}`, spec.limit, spec.windowMs);
  if (!allowed) throw new RateLimitError();
}

export function clientKey(request: Request): string {
  // Forwarding headers are client-controlled unless the deployment explicitly declares a trusted proxy.
  // Do not let arbitrary callers rotate spoofed IPs to evade the process-local budget.
  if (process.env.MERIDIAN_TRUST_PROXY_HEADERS !== "true") return "untrusted-client";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && forwarded.length <= 80) return forwarded;
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp && realIp.length <= 80) return realIp;
  return "unknown";
}

/** Larger bodies are not read to find an account; they fall back to the per-route bucket. */
const ACCOUNT_BODY_MAX_BYTES = 4096;

/**
 * The account a credential request targets: the `email` of a small JSON POST (email sign-in,
 * sign-up, password reset). Anything else returns undefined. Never throws.
 */
export async function attemptedAccount(request: Request): Promise<string | undefined> {
  if (request.method !== "POST") return undefined;
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return undefined;
  const declared = Number(request.headers.get("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= 0 || declared > ACCOUNT_BODY_MAX_BYTES) return undefined;
  try {
    const body: unknown = await request.clone().json();
    const email = body && typeof body === "object" ? (body as { email?: unknown }).email : undefined;
    if (typeof email !== "string") return undefined;
    const normalized = email.trim().toLowerCase();
    return normalized && normalized.length <= 320 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bucket for one auth attempt. Every bucket is scoped to its route, so one route cannot lock out another.
 * With a trusted proxy, the bucket is the client address. Without one, a client address is attacker-chosen
 * and a single shared bucket lets one caller lock out everyone, so the bucket is the targeted account instead:
 * guessing against any one account stays capped whatever the source, and other accounts stay usable.
 */
export function authAttemptKey(request: Request, account: string | undefined): string {
  const route = new URL(request.url).pathname;
  if (process.env.MERIDIAN_TRUST_PROXY_HEADERS === "true") return `${route}|client:${clientKey(request)}`;
  return account ? `${route}|account:${account}` : `${route}|untrusted-client`;
}
