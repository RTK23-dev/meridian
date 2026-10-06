import type { Transport } from "../providers/http.ts";
import { liveTransport, sendWithRetry } from "../providers/http.ts";

const SUBMIT_URL = "https://api.x.ai/v1/videos/generations";
const MODEL = "grok-imagine-video-1.5";

export type XaiVideoState = {
  provider: "xai:video";
  model: string;
  providerJobId: string;
  status: "not_connected" | "submitted" | "processing" | "completed" | "failed";
  prompt: string;
  error: string;
  outputUrl: string;
  bytes: Uint8Array | null;
  durationMs: number | null;
};

function keyFromEnv(explicit?: string): string {
  if (explicit !== undefined) return explicit.trim();
  return process.env.XAI_API_KEY?.trim() ?? "";
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

async function downloadLive(url: string, apiKey: string): Promise<Uint8Array | null> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength >= 16 ? bytes : null;
}

/**
 * Real xAI video job. Missing credentials return not_connected and no bytes.
 * A completed clip is stored only after the provider returns a URL and the download succeeds.
 */
export async function submitXaiVideo(input: { prompt: string; apiKey?: string; transport?: Transport }): Promise<XaiVideoState> {
  const apiKey = keyFromEnv(input.apiKey);
  const base: XaiVideoState = {
    provider: "xai:video",
    model: MODEL,
    providerJobId: "",
    status: "not_connected",
    prompt: input.prompt,
    error: "",
    outputUrl: "",
    bytes: null,
    durationMs: null,
  };
  if (!apiKey) {
    return { ...base, error: "EXTERNAL_CONNECTION_REQUIRED: XAI_API_KEY is not set. No video was created." };
  }
  const transport = input.transport ?? liveTransport();
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: SUBMIT_URL,
    headers: auth(apiKey),
    body: JSON.stringify({
      model: MODEL,
      prompt: input.prompt.slice(0, 4000),
      duration: 6,
      aspect_ratio: "16:9",
      resolution: "720p",
    }),
  });
  const requestId = result.json && typeof result.json === "object" ? (result.json as { request_id?: unknown }).request_id : null;
  if (!result.ok || typeof requestId !== "string" || !requestId.trim()) {
    return {
      ...base,
      status: "failed",
      error: `xAI video submit failed (${result.status || "network"}). No clip was stored.`,
    };
  }
  return { ...base, status: "submitted", providerJobId: requestId };
}

export async function pollXaiVideo(
  state: XaiVideoState,
  input: { apiKey?: string; transport?: Transport; download?: (url: string) => Promise<Uint8Array | null> },
): Promise<XaiVideoState> {
  const apiKey = keyFromEnv(input.apiKey);
  if (!apiKey) {
    return { ...state, status: "not_connected", bytes: null, error: "EXTERNAL_CONNECTION_REQUIRED: XAI_API_KEY is not set." };
  }
  if (!state.providerJobId) {
    return { ...state, status: "failed", bytes: null, error: "xAI video poll has no request id." };
  }
  const transport = input.transport ?? liveTransport();
  const result = await sendWithRetry(
    transport,
    { method: "GET", url: `https://api.x.ai/v1/videos/${encodeURIComponent(state.providerJobId)}`, headers: auth(apiKey) },
    { attempts: 1 },
  );
  const body =
    result.json && typeof result.json === "object"
      ? (result.json as { status?: unknown; video?: { url?: unknown; duration?: unknown } })
      : null;
  if (!result.ok || !body || typeof body.status !== "string") {
    return { ...state, status: "failed", bytes: null, error: `xAI video poll failed (${result.status || "network"}). No clip was stored.` };
  }
  if (body.status === "pending" || body.status === "processing" || body.status === "queued") {
    return { ...state, status: "processing", bytes: null, error: "" };
  }
  if (body.status === "failed" || body.status === "expired") {
    return { ...state, status: "failed", bytes: null, error: `xAI video ${body.status}. No clip was stored.` };
  }
  if (body.status !== "done") {
    return { ...state, status: "failed", bytes: null, error: "xAI video returned an unknown status. No clip was stored." };
  }
  const url = body.video?.url;
  const duration = typeof body.video?.duration === "number" ? Math.round(body.video.duration * 1000) : null;
  if (typeof url !== "string" || !url.startsWith("https://")) {
    return { ...state, status: "failed", bytes: null, error: "xAI video completed without an https URL. No clip was stored." };
  }
  const bytes = input.download ? await input.download(url) : await downloadLive(url, apiKey);
  if (!bytes || bytes.byteLength < 16) {
    return { ...state, status: "failed", outputUrl: url, bytes: null, error: "xAI video download was empty. No clip was stored." };
  }
  return { ...state, status: "completed", outputUrl: url, durationMs: duration, bytes, error: "" };
}
