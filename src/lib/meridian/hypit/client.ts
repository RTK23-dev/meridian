import { createHash } from "node:crypto";
import type { Transport } from "../providers/http.ts";
import { inspectVideo } from "../video/inspect.ts";
import type { HypitJobContract } from "./contract.ts";

/**
 * Talks to a separately deployed Hypit process.
 * The process is not vendored here. These routes are Meridian's handoff, not Hypit's CLI.
 * HYPIT_BASE_URL empty means the runtime is not connected. No other provider is called.
 */
export type HypitConnection =
  | { status: "EXTERNAL_CONNECTION_REQUIRED"; code: "HYPIT_NOT_CONNECTED"; detail: string }
  | { status: "CONFIGURED"; baseUrl: string; token: string };

export type HypitRemoteStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type HypitRemoteJob = {
  providerJobId: string;
  status: HypitRemoteStatus;
  error: string;
};

export type HypitArtifactPayload = {
  mime: string;
  bytes: Uint8Array;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  sha256: string;
};

const STATUSES = new Set<HypitRemoteStatus>(["queued", "running", "succeeded", "failed", "cancelled"]);

/**
 * The Hypit connection. The base URL is deployment configuration. The token is the workspace's, passed in by the caller that
 * resolved it through the credential resolver, so this function never reads a token from the environment.
 */
export function hypitConnection(env: { baseUrl?: string; token?: string | null } = {}): HypitConnection {
  const raw = (env.baseUrl ?? process.env.HYPIT_BASE_URL ?? "").trim();
  if (!raw) {
    return {
      status: "EXTERNAL_CONNECTION_REQUIRED",
      code: "HYPIT_NOT_CONNECTED",
      detail: "Set HYPIT_BASE_URL to a separate Hypit process. No video was requested.",
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      status: "EXTERNAL_CONNECTION_REQUIRED",
      code: "HYPIT_NOT_CONNECTED",
      detail: "HYPIT_BASE_URL is not a usable address. No video was requested.",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      status: "EXTERNAL_CONNECTION_REQUIRED",
      code: "HYPIT_NOT_CONNECTED",
      detail: "HYPIT_BASE_URL must be http or https. No video was requested.",
    };
  }
  const baseUrl = `${url.origin}${url.pathname}`.replace(/\/$/, "");
  const token = (env.token ?? "").trim();
  return { status: "CONFIGURED", baseUrl, token };
}

function headers(token: string): Record<string, string> {
  const result: Record<string, string> = { accept: "application/json" };
  if (token) result.authorization = `Bearer ${token}`;
  return result;
}

export function looksLikeVideo(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16) return false;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
  const inspected = inspectVideo(bytes);
  return inspected.container === "mp4" && (inspected.durationMs != null || inspected.width != null);
}

export async function startHypitJob(
  connection: Extract<HypitConnection, { status: "CONFIGURED" }>,
  contract: HypitJobContract,
  transport: Transport,
): Promise<{ ok: true; job: HypitRemoteJob } | { ok: false; code: "HYPIT_FAILED" | "HYPIT_MALFORMED"; error: string }> {
  let response: { status: number; body: string };
  try {
    response = await transport({
      method: "POST",
      url: `${connection.baseUrl}/v1/jobs`,
      headers: {
        ...headers(connection.token),
        "content-type": "application/json",
        "idempotency-key": contract.meridianJobId,
      },
      body: JSON.stringify(contract),
    });
  } catch {
    return { ok: false, code: "HYPIT_FAILED", error: "The Hypit process did not respond. No video was stored." };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: "HYPIT_FAILED", error: `Hypit refused the job (${response.status}). No video was stored.` };
  }
  const parsed = parseJob(response.body);
  if (!parsed) return { ok: false, code: "HYPIT_MALFORMED", error: "Hypit returned a job response Meridian could not read." };
  return { ok: true, job: parsed };
}

export async function pollHypitJob(
  connection: Extract<HypitConnection, { status: "CONFIGURED" }>,
  providerJobId: string,
  transport: Transport,
): Promise<{ ok: true; job: HypitRemoteJob } | { ok: false; code: "HYPIT_FAILED" | "HYPIT_MALFORMED"; error: string }> {
  let response: { status: number; body: string };
  try {
    response = await transport({
      method: "GET",
      url: `${connection.baseUrl}/v1/jobs/${encodeURIComponent(providerJobId)}`,
      headers: headers(connection.token),
    });
  } catch {
    return { ok: false, code: "HYPIT_FAILED", error: "The Hypit process did not respond while the job was polled." };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: "HYPIT_FAILED", error: `Hypit poll failed (${response.status}).` };
  }
  const parsed = parseJob(response.body);
  if (!parsed || parsed.providerJobId !== providerJobId) {
    return { ok: false, code: "HYPIT_MALFORMED", error: "Hypit returned a poll response Meridian could not read." };
  }
  return { ok: true, job: parsed };
}

export async function collectHypitArtifact(
  connection: Extract<HypitConnection, { status: "CONFIGURED" }>,
  providerJobId: string,
  transport: Transport,
): Promise<{ ok: true; artifact: HypitArtifactPayload } | { ok: false; code: "HYPIT_FAILED" | "HYPIT_MALFORMED" | "HYPIT_MISSING_ASSET"; error: string }> {
  let response: { status: number; body: string };
  try {
    response = await transport({
      method: "GET",
      url: `${connection.baseUrl}/v1/jobs/${encodeURIComponent(providerJobId)}/artifact`,
      headers: headers(connection.token),
    });
  } catch {
    return { ok: false, code: "HYPIT_FAILED", error: "The Hypit process did not return the artifact." };
  }
  if (response.status === 404 || response.status === 204) {
    return { ok: false, code: "HYPIT_MISSING_ASSET", error: "Hypit reported completion without an artifact." };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: "HYPIT_FAILED", error: `Hypit artifact request failed (${response.status}).` };
  }
  let body: unknown;
  try {
    body = JSON.parse(response.body) as unknown;
  } catch {
    return { ok: false, code: "HYPIT_MALFORMED", error: "Hypit artifact response was not JSON." };
  }
  if (!body || typeof body !== "object") {
    return { ok: false, code: "HYPIT_MALFORMED", error: "Hypit artifact response was empty." };
  }
  const record = body as { mime?: unknown; base64?: unknown; durationMs?: unknown; width?: unknown; height?: unknown };
  const mime = typeof record.mime === "string" ? record.mime.trim() : "";
  const encoded = typeof record.base64 === "string" ? record.base64.trim() : "";
  if (!mime.startsWith("video/") || !encoded) {
    return { ok: false, code: "HYPIT_MISSING_ASSET", error: "Hypit completion did not include video bytes." };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  } catch {
    return { ok: false, code: "HYPIT_MALFORMED", error: "Hypit artifact bytes could not be decoded." };
  }
  if (!looksLikeVideo(bytes)) {
    return { ok: false, code: "HYPIT_MISSING_ASSET", error: "Hypit completion did not include a video container." };
  }
  return {
    ok: true,
    artifact: {
      mime,
      bytes,
      durationMs: finite(record.durationMs),
      width: finite(record.width),
      height: finite(record.height),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseJob(body: string): HypitRemoteJob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { providerJobId?: unknown; status?: unknown; error?: unknown };
  const providerJobId = typeof record.providerJobId === "string" ? record.providerJobId.trim() : "";
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!providerJobId || !STATUSES.has(status as HypitRemoteStatus)) return null;
  return {
    providerJobId,
    status: status as HypitRemoteStatus,
    error: typeof record.error === "string" ? record.error.slice(0, 500) : "",
  };
}
