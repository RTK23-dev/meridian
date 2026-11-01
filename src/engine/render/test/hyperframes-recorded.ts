// Recorded responses for the HyperFrames cloud adapter tests (Bible 17.3, recorded adapters).
//
// IMPORTANT: these are CONSTRUCTED, not captured from the live API. Their shapes follow the HyperFrames CLI 0.8.154
// client source: the request paths and bodies come from chunk-IYLHJV34.js (HyperframesCloudClient) and
// render-LUAMJOON.js (uploadZipViaDirectUpload, submitRender, buildRenderBody); the { data } envelope and the { error }
// envelope come from the same client. The live run that records real responses is the owner's (STATUS.md).

export type ScriptedExchange = {
  method: "GET" | "POST" | "PUT";
  /** Exact URL, or a prefix match when the URL depends on an id the adapter receives. */
  url: string;
  urlPrefix?: boolean;
  status: number;
  /** A JSON body, when the response is JSON. */
  json?: unknown;
  /** A raw body, for the video download. */
  bytes?: Uint8Array;
  /** Header names that must be present (or absent, with a leading "!") on the request. */
  requireHeaders?: string[];
  /** Header values that must match exactly. */
  expectHeaders?: Record<string, string>;
};

export const UPLOAD_URL = "https://upload.storage.example/presigned/composition.zip?X-Amz-Signature=fixture";
export const ASSET_ID = "asst_fixture_0001";
export const RENDER_ID = "hfr_fixture_0001";
export const VIDEO_URL = "https://video.storage.example/hfr_fixture_0001.mp4?X-Amz-Signature=fixture";
export const VIDEO_BYTES = new TextEncoder().encode("fixture mp4 bytes, not a real video");

export function uploadStart(): ScriptedExchange {
  return {
    method: "POST",
    url: "https://api.heygen.com/v3/assets/direct-uploads",
    status: 200,
    json: { data: { asset_id: ASSET_ID, upload_url: UPLOAD_URL, upload_headers: {} } },
    requireHeaders: ["x-api-key", "X-HeyGen-Client-Source", "Idempotency-Key"],
  };
}

export function uploadPut(): ScriptedExchange {
  return { method: "PUT", url: UPLOAD_URL, status: 200, requireHeaders: ["!x-api-key", "!Idempotency-Key"] };
}

export function uploadComplete(status = 200): ScriptedExchange {
  return {
    method: "POST",
    url: `https://api.heygen.com/v3/assets/${ASSET_ID}/complete`,
    status,
    json: status === 200 ? { data: { asset_id: ASSET_ID } } : { error: { message: "asset not ready", code: "conflict" } },
    requireHeaders: ["x-api-key"],
  };
}

export function renderCreate(status = 200): ScriptedExchange {
  return {
    method: "POST",
    url: "https://api.heygen.com/v3/hyperframes/renders",
    status,
    json: status === 200 ? { data: { render_id: RENDER_ID, status: "queued" } } : undefined,
    requireHeaders: ["x-api-key", "Idempotency-Key"],
  };
}

export function renderPoll(status: "queued" | "rendering" | "completed" | "failed", extra: Record<string, unknown> = {}): ScriptedExchange {
  return {
    method: "GET",
    url: `https://api.heygen.com/v3/hyperframes/renders/${RENDER_ID}`,
    status: 200,
    json: { data: { render_id: RENDER_ID, status, format: "mp4", ...extra } },
    requireHeaders: ["x-api-key"],
  };
}

export function videoDownload(): ScriptedExchange {
  return { method: "GET", url: VIDEO_URL, status: 200, bytes: VIDEO_BYTES, requireHeaders: ["!x-api-key"] };
}

/** A failed JSON response in the cloud API's error envelope. */
export function apiError(method: ScriptedExchange["method"], url: string, status: number, code: string, message: string): ScriptedExchange {
  return { method, url, status, json: { error: { code, message } } };
}

/** The exchanges of one successful render: upload, submit, one rendering poll, one completed poll, download. */
export function successfulRender(): ScriptedExchange[] {
  return [uploadStart(), uploadPut(), uploadComplete(), renderCreate(), renderPoll("rendering"), renderPoll("completed", { video_url: VIDEO_URL, duration: 6 }), videoDownload()];
}
