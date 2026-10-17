// Deepgram answers for the adapter tests (stt-deepgram.ts). SYNTHETIC: no call has been made, so no answer here was captured. Each
// one is written to the shape Deepgram's API reference describes (read on 2026-10-16):
//   - POST /v1/listen: metadata.request_id and metadata.duration (seconds); the words at
//     results.channels[0].alternatives[0].words[] with word, start, end (seconds) and confidence.
//   - GET /v1/projects/{project_id}/requests/{request_id}: the bill at request.response.details.usd (USD).
// The error bodies follow Deepgram's err_code / err_msg shape. The owner's live run replaces every one of these with a captured answer
// (media/STATUS.md). The ids are made up.

import type { HttpResponse } from "../../gateway/types.ts";

/** The audio the recordings describe: 2.6 s, the same line as the STT recordings in src/engine/test/fixtures/recorded/stt.ts. */
export const DEEPGRAM_AUDIO_MS = 2600;
export const DEEPGRAM_PROJECT_ID = "3c9e1d7a-5b2f-4e8a-9d61-7f0c2a4b8e15";
export const DEEPGRAM_REQUEST_ID = "3f2a9c1e-7b64-4d0a-8e15-6c2b9d4f1a70";
/** About 2.6 s at $0.0043 a minute (config/prices.ts). The ledger keeps four decimals, so the bill settles at 0.0002. */
export const DEEPGRAM_BILL_USD = 0.000186;

export type DeepgramWord = {
  word: string;
  punctuated_word: string;
  start: number;
  end: number;
  confidence: number;
};

/** "Your kitchen counter is lying to you.", word by word, with the same timings as the STT recordings. */
export const DEEPGRAM_WORDS: DeepgramWord[] = [
  { word: "your", punctuated_word: "Your", start: 0.12, end: 0.38, confidence: 0.98 },
  { word: "kitchen", punctuated_word: "kitchen", start: 0.4, end: 0.81, confidence: 0.97 },
  { word: "counter", punctuated_word: "counter", start: 0.84, end: 1.3, confidence: 0.96 },
  { word: "is", punctuated_word: "is", start: 1.34, end: 1.44, confidence: 0.99 },
  { word: "lying", punctuated_word: "lying", start: 1.48, end: 1.92, confidence: 0.95 },
  { word: "to", punctuated_word: "to", start: 1.95, end: 2.06, confidence: 0.99 },
  { word: "you", punctuated_word: "you.", start: 2.09, end: 2.41, confidence: 0.97 },
];

/** A transcription answer. Pass requestId: null to leave the request id out. */
export function listenAnswer(
  overrides: { words?: DeepgramWord[]; duration?: number; requestId?: string | null } = {},
): unknown {
  const metadata: Record<string, unknown> = { duration: overrides.duration ?? 2.6, channels: 1 };
  if (overrides.requestId !== null) {
    metadata.request_id = overrides.requestId ?? DEEPGRAM_REQUEST_ID;
  }
  return {
    metadata,
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript: "Your kitchen counter is lying to you.",
              confidence: 0.97,
              words: overrides.words ?? DEEPGRAM_WORDS,
            },
          ],
        },
      ],
    },
  };
}

/** A request-lookup answer carrying the bill. Pass usd: null (or another value) to test an unusable amount. */
export function billAnswer(overrides: { usd?: unknown; requestId?: string } = {}): unknown {
  return {
    request: {
      request_id: overrides.requestId ?? DEEPGRAM_REQUEST_ID,
      project_uuid: DEEPGRAM_PROJECT_ID,
      path: "/v1/listen?",
      response: {
        code: 200,
        details: {
          channels: 1,
          duration: 2.6,
          total_audio: 2.6,
          method: "sync",
          tier: "base",
          usd: overrides.usd === undefined ? DEEPGRAM_BILL_USD : overrides.usd,
        },
      },
    },
  };
}

const encoder = new TextEncoder();

export function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: encoder.encode(JSON.stringify(body)),
  };
}

export function listenOk(overrides?: Parameters<typeof listenAnswer>[0]): HttpResponse {
  return jsonResponse(200, listenAnswer(overrides));
}

export function billOk(overrides?: Parameters<typeof billAnswer>[0]): HttpResponse {
  return jsonResponse(200, billAnswer(overrides));
}

const ERRORS: Record<number, { err_code: string; err_msg: string }> = {
  400: { err_code: "Bad Request", err_msg: "Bad request: the audio could not be decoded." },
  401: { err_code: "INVALID_AUTH", err_msg: "Invalid credentials." },
  403: { err_code: "FORBIDDEN", err_msg: "Insufficient permissions for this project." },
  404: { err_code: "NOT_FOUND", err_msg: "No such request." },
  408: { err_code: "REQUEST_TIMEOUT", err_msg: "The request timed out." },
  429: { err_code: "TOO_MANY_REQUESTS", err_msg: "Rate limit exceeded. Retry later." },
  500: { err_code: "INTERNAL_SERVER_ERROR", err_msg: "Something went wrong." },
  503: { err_code: "SERVICE_UNAVAILABLE", err_msg: "The service is unavailable." },
};

/** A non-2xx answer with Deepgram's error body. */
export function refusal(status: keyof typeof ERRORS): HttpResponse {
  return jsonResponse(status, ERRORS[status]);
}

/**
 * A project-list answer (GET /v1/projects): one entry per project the key reaches. SYNTHETIC, written to the documented shape
 * (projects[].project_id). UNVERIFIED LIVE: the owner's live run records a real answer.
 */
export function projectsAnswer(projectIds: readonly string[]): unknown {
  return {
    projects: projectIds.map((projectId) => ({
      project_id: projectId,
      name: "Synthetic project",
      mip_opt_out: false,
    })),
  };
}

export function projectsOk(projectIds: readonly string[] = [DEEPGRAM_PROJECT_ID]): HttpResponse {
  return jsonResponse(200, projectsAnswer(projectIds));
}
