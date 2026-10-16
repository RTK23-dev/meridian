// Speech-to-text recordings in the vendor-neutral shape of media/stt.ts (recordedSpeechToText). Every one is SYNTHETIC:
// no vendor is chosen (Bible 20.2), so no live call has been made and nothing here came from a provider. Each recording
// is about the same 2.6 s line, "Your kitchen counter is lying to you": a hand-written stand-in until the owner records a
// real call. The error entries use the ProviderError kinds of Bible 10.1 and the retry rules of 10.4.

import type { RawWord, RecordedSttFixture } from "../../../media/stt.ts";

export const STT_AUDIO_MS = 2600;

export const STT_WORDS: RawWord[] = [
  { text: "Your", start: 0.12, end: 0.38, confidence: 0.98 },
  { text: "kitchen", start: 0.4, end: 0.81, confidence: 0.97 },
  { text: "counter", start: 0.84, end: 1.3, confidence: 0.96 },
  { text: "is", start: 1.34, end: 1.44, confidence: 0.99 },
  { text: "lying", start: 1.48, end: 1.92, confidence: 0.95 },
  { text: "to", start: 1.95, end: 2.06, confidence: 0.99 },
  { text: "you", start: 2.09, end: 2.41, confidence: 0.97 },
];

const SYNTHETIC_AT = "2026-10-14T00:00:00.000Z";
const PROVIDER = "synthetic-stt";
const MODEL = "word-timestamps";

/** Success with the vendor's bill. */
export const sttSuccessRecording: RecordedSttFixture = {
  provider: PROVIDER,
  model: MODEL,
  source: "synthetic",
  recordedAt: SYNTHETIC_AT,
  responses: [{ outcome: "ok", language: "en", billedUsd: 0.0043, words: STT_WORDS }],
};

/** Success without a bill: the caller reconciles to the list price, flagged as an estimate. */
export const sttNoBillRecording: RecordedSttFixture = {
  provider: PROVIDER,
  model: MODEL,
  source: "synthetic",
  recordedAt: SYNTHETIC_AT,
  responses: [{ outcome: "ok", language: "en", billedUsd: null, words: STT_WORDS }],
};

/** Rate limited once, then a success: a retry with the same key. */
export const sttRateLimitThenSuccessRecording: RecordedSttFixture = {
  provider: PROVIDER,
  model: MODEL,
  source: "synthetic",
  recordedAt: SYNTHETIC_AT,
  responses: [
    {
      outcome: "error",
      error: { kind: "rate_limit", retryable: true, message: "HTTP 429: retry after 20 seconds" },
    },
    { outcome: "ok", language: "en", billedUsd: 0.0043, words: STT_WORDS },
  ],
};

/** The call timed out at the client. */
export const sttTimeoutRecording: RecordedSttFixture = {
  provider: PROVIDER,
  model: MODEL,
  source: "synthetic",
  recordedAt: SYNTHETIC_AT,
  responses: [
    {
      outcome: "error",
      error: { kind: "timeout", retryable: true, message: "no response within 120 s" },
    },
  ],
};

/** The vendor refused the audio on content policy. Not retryable: the caller must change the input, not retry it. */
export const sttPolicyRefusalRecording: RecordedSttFixture = {
  provider: PROVIDER,
  model: MODEL,
  source: "synthetic",
  recordedAt: SYNTHETIC_AT,
  responses: [
    {
      outcome: "error",
      error: { kind: "content_policy", retryable: false, message: "audio refused by policy" },
    },
  ],
};

/** The second word starts before the first one does. The transcript must be rejected. */
export const sttOutOfOrderRecording: RecordedSttFixture = {
  provider: PROVIDER,
  model: MODEL,
  source: "synthetic",
  recordedAt: SYNTHETIC_AT,
  responses: [
    {
      outcome: "ok",
      language: "en",
      billedUsd: 0.0043,
      words: [
        { text: "Your", start: 0.5, end: 0.8, confidence: 0.98 },
        { text: "kitchen", start: 0.2, end: 0.7, confidence: 0.97 },
      ],
    },
  ],
};
