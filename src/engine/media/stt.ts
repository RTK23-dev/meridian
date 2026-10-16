// Speech-to-text (Bible 6.2 step 3, 6.3 step 3, 20.2). The vendor is an open owner decision, so this file has the
// interface, the validation every vendor's answer must pass, the metered wrapper, and recordedSpeechToText, which
// replays recorded responses for tests. No vendor is wired here. Production code must not use recordedSpeechToText.

import { createHash } from "node:crypto";
import { z } from "zod";
import { authorizeCall } from "../budget/reserve.ts";
import { reconcileCall } from "../budget/reconcile.ts";
import type { LedgerStore } from "../budget/store.ts";
import { EngineError } from "../contracts/errors.ts";
import { canonicalJson } from "../contracts/hash.ts";
import { roundUsd, usdSchema } from "../contracts/money.ts";
import type { ProviderError, Word } from "../contracts/index.ts";
import { wordSchema } from "../contracts/analysis.ts";
import type { MediaSource } from "../../../functions/ffmpeg/types.ts";
import { mediaConfig } from "./config.ts";

const STAGE = "speech_to_text";
const MS_PER_MINUTE = 60_000;
/** True when the text has a C0 control character or DEL. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

export type SttRequest = {
  /** The audio (or the video that carries it): a URL the vendor can fetch, or bytes. */
  source: MediaSource;
  /** The audio duration in ms, from probe. The transcript must fit inside it. */
  durationMs: number;
  /** The script or reference language, for example "en". */
  language: string;
};

export type SttResult = {
  /** Words with ids and integer millisecond timings, validated against the Word contract. */
  words: Word[];
  language: string;
  /** The vendor's bill for the call, or null when the vendor did not report one. */
  billedUsd: number | null;
};

/**
 * What a speech-to-text vendor must offer (Bible 20.2): word timestamps, a confidence per word, the language, and a
 * price per minute. transcribe() sends idempotencyKey to the vendor and must never bill a repeat of the same key twice.
 */
export interface SpeechToText {
  readonly provider: string;
  readonly model: string;
  transcribe(request: SttRequest, idempotencyKey: string): Promise<SttResult>;
}

/** One word as a vendor reports it, in seconds, before validation. */
export type RawWord = { text: string; start: number; end: number; confidence: number };

const rawTranscriptSchema = z.object({
  language: z.string().min(1).max(16),
  words: z
    .array(
      z.object({
        text: z.string(),
        start: z.number().finite(),
        end: z.number().finite(),
        confidence: z.number().finite(),
      }),
    )
    .max(mediaConfig.transcript.maxWords),
});

function invalidTranscript(reason: string): EngineError {
  return new EngineError("provider", `speech-to-text returned an invalid transcript: ${reason}`, {
    retryable: false,
    stage: STAGE,
  });
}

function primaryLanguage(tag: string): string {
  return tag.toLowerCase().split("-")[0] ?? "";
}

/**
 * Validates a vendor's transcript before anything stores it (Bible 2: provider outputs are untrusted). Each word must be
 * one token of 1 to 64 characters with no control characters, must start no earlier than the word before it, must end
 * after it starts, must end within the audio (plus a small tolerance), and must have a confidence between 0 and 1. The
 * language must match the request. Word ids are w0001, w0002, and so on. Any failure rejects the whole transcript.
 */
export function normaliseTranscript(
  raw: unknown,
  request: { durationMs: number; language: string },
): { words: Word[]; language: string } {
  const parsed = rawTranscriptSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw invalidTranscript(
      first ? `${first.path.map(String).join(".")}: ${first.message}` : "unreadable shape",
    );
  }
  if (primaryLanguage(parsed.data.language) !== primaryLanguage(request.language)) {
    throw invalidTranscript(
      `language ${parsed.data.language} does not match the requested ${request.language}`,
    );
  }
  const limits = mediaConfig.transcript;
  let previousStartMs = 0;
  const words = parsed.data.words.map((word, index): Word => {
    const label = `word ${index + 1}`;
    const token = word.text.trim();
    if (
      token.length === 0 ||
      token.length > limits.maxWordChars ||
      hasControlCharacter(token) ||
      /\s/.test(token)
    ) {
      throw invalidTranscript(
        `${label} is not a single token of 1 to ${limits.maxWordChars} characters`,
      );
    }
    if (word.start < 0) {
      throw invalidTranscript(`${label} starts before the audio`);
    }
    const startMs = Math.round(word.start * 1000);
    const endMs = Math.round(word.end * 1000);
    if (startMs < previousStartMs) {
      throw invalidTranscript(`${label} starts before the word before it`);
    }
    if (endMs <= startMs) {
      throw invalidTranscript(`${label} does not end after it starts`);
    }
    if (endMs > request.durationMs + limits.endToleranceMs) {
      throw invalidTranscript(
        `${label} ends after the audio (${endMs} ms against ${request.durationMs} ms)`,
      );
    }
    if (word.confidence < 0 || word.confidence > 1) {
      throw invalidTranscript(`${label} has a confidence outside 0 to 1`);
    }
    previousStartMs = startMs;
    const checked = wordSchema.safeParse({
      wordId: `w${String(index + 1).padStart(4, "0")}`,
      text: token,
      startMs,
      endMs,
      confidence: word.confidence,
    });
    if (!checked.success) {
      throw invalidTranscript(`${label} does not match the word contract`);
    }
    return checked.data;
  });
  return { words, language: parsed.data.language };
}

/** A vendor's bill: null (unreported) or a USD amount with at most 4 decimals. Anything else is refused. */
export function checkBilledUsd(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = usdSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidTranscript("the bill is not a USD amount");
  }
  return parsed.data;
}

/** A failed call, typed. retryable comes from the vendor's classification (rate limit, timeout and server errors retry). */
export class SttCallError extends EngineError {
  providerKind: ProviderError["kind"];

  constructor(error: ProviderError, stage: string = STAGE) {
    super("provider", `speech-to-text ${error.kind}: ${error.message}`, {
      retryable: error.retryable,
      stage,
    });
    this.name = "SttCallError";
    this.providerKind = error.kind;
  }
}

function sourceDigest(source: MediaSource): string {
  const hash = createHash("sha256");
  if (source.kind === "url") {
    hash.update(source.url);
  } else {
    hash.update(source.bytes);
  }
  return hash.digest("hex");
}

/** Idempotency key: sha256 of the provider, model, language, duration and input (Bible 10.4). */
export function sttIdempotencyKey(
  stt: Pick<SpeechToText, "provider" | "model">,
  request: SttRequest,
): string {
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        provider: stt.provider,
        model: stt.model,
        language: request.language,
        durationMs: request.durationMs,
        source: { kind: request.source.kind, digest: sourceDigest(request.source) },
      }),
    )
    .digest("hex");
  return `stt:${digest}`;
}

/**
 * Estimated cost of one call at the vendor's price per minute. An unknown price (null) refuses the call: the Bible
 * says a null price is never a guess and never 0.
 */
export function estimateSttUsd(
  durationMs: number,
  pricePerMinuteUsd: number | null,
  stage: string = STAGE,
): number {
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new EngineError(
      "invalid_input",
      "the audio duration must be a positive whole number of milliseconds",
      { stage },
    );
  }
  if (pricePerMinuteUsd === null) {
    throw new EngineError(
      "unknown_price",
      "the speech-to-text price is unknown: the vendor is not chosen (Bible 20.2). The call is refused, not estimated.",
      { stage },
    );
  }
  return roundUsd((pricePerMinuteUsd * durationMs) / MS_PER_MINUTE);
}

/** The ledger context for a call. The reservation is made by the caller's estimate_reserve stage. */
export type SttMeter = {
  store: LedgerStore;
  reservationId: string;
  stage: string;
  /** The vendor's list price per minute (prices.ts, speech-to-text key). Null refuses the call. */
  pricePerMinuteUsd: number | null;
  /** ISO time of the call. */
  at: string;
};

export type MeteredSttResult = {
  result: SttResult;
  idempotencyKey: string;
  entryId: string;
  estimateUsd: number;
  /** The vendor's bill, or null while none is known. Never the estimate (contract v6). */
  actualUsd: number | null;
  /** True when the call is settled (its bill is recorded). A transcript whose call is unsettled is still returned, and its cost stays unknown. */
  settled: boolean;
};

/**
 * Runs one transcription with its budget: estimate, authorise against the reservation with an idempotency key, call the
 * vendor, then settle to the vendor's bill. With no bill the call stays held and its cost unknown; nothing is estimated (contract v6).
 * - A key already on the ledger is never sent again. A settled one is refused and its stored transcript is reused; an unsettled one
 *   (the last call failed or returned no bill) waits to be settled, because the vendor may have billed it (contract v6).
 * - A failed call leaves its hold in place. It is not released here, because the vendor may have billed the call.
 */
export async function transcribeMetered(
  stt: SpeechToText,
  request: SttRequest,
  meter: SttMeter,
): Promise<MeteredSttResult> {
  const estimateUsd = estimateSttUsd(request.durationMs, meter.pricePerMinuteUsd, meter.stage);
  const idempotencyKey = sttIdempotencyKey(stt, request);
  const authorised = await authorizeCall(meter.store, {
    reservationId: meter.reservationId,
    stage: meter.stage,
    provider: stt.provider,
    model: stt.model,
    estimateUsd,
    idempotencyKey,
    at: meter.at,
  });
  if (authorised.status === "refused") {
    throw new EngineError("conflict", `speech-to-text call refused: ${authorised.reason}`, {
      stage: meter.stage,
    });
  }
  // A key already on the ledger is never sent again: the vendor may have billed it, and the key is not a confirmed guarantee against a
  // second bill (contract v6). An unsettled call waits for its bill or confirmation; a settled one is reused from storage.
  if (authorised.status === "duplicate") {
    throw new EngineError(
      "conflict",
      authorised.entry.settlement === undefined
        ? `speech-to-text call ${idempotencyKey} was made and its cost is unsettled, so it is not sent again: settle it first`
        : `speech-to-text call ${idempotencyKey} was already made and billed: reuse the stored transcript`,
      { stage: meter.stage, retryable: false },
    );
  }

  const result = await stt.transcribe(request, idempotencyKey);
  const reconciled = await reconcileCall(meter.store, {
    idempotencyKey,
    ...(result.billedUsd === null ? {} : { billedUsd: result.billedUsd }),
  });
  return {
    result,
    idempotencyKey,
    entryId: reconciled.entry.entryId,
    estimateUsd,
    actualUsd: reconciled.entry.actualUsd ?? null,
    settled: reconciled.settled,
  };
}

// --- Recorded adapter (tests only) -----------------------------------------------------------------------------

export type RecordedSttResponse =
  | { outcome: "ok"; language: string; words: RawWord[]; billedUsd: number | null }
  | { outcome: "error"; error: ProviderError };

export type RecordedSttFixture = {
  provider: string;
  model: string;
  /** "synthetic": hand-written to the vendor-neutral shape. "live": captured from a real call by the owner. */
  source: "synthetic" | "live";
  recordedAt: string;
  responses: RecordedSttResponse[];
};

export type RecordedSpeechToText = SpeechToText & {
  /** Idempotency keys received, in call order. */
  readonly calls: readonly string[];
};

/**
 * Replays the fixture's responses in order, through the same validation as a live vendor. Each call consumes one
 * response. A recording that has run out is an internal error, never a guessed transcript. No network, no vendor.
 */
export function recordedSpeechToText(fixture: RecordedSttFixture): RecordedSpeechToText {
  const calls: string[] = [];
  let cursor = 0;
  return {
    provider: fixture.provider,
    model: fixture.model,
    get calls(): readonly string[] {
      return calls;
    },
    async transcribe(request: SttRequest, idempotencyKey: string): Promise<SttResult> {
      calls.push(idempotencyKey);
      const next = fixture.responses[cursor];
      if (next === undefined) {
        throw new EngineError(
          "internal",
          `the recording for ${fixture.provider} has no response left for call ${cursor + 1}`,
          { stage: STAGE },
        );
      }
      cursor += 1;
      if (next.outcome === "error") {
        throw new SttCallError(next.error, STAGE);
      }
      const normalised = normaliseTranscript(
        { language: next.language, words: next.words },
        request,
      );
      return {
        words: normalised.words,
        language: normalised.language,
        billedUsd: checkBilledUsd(next.billedUsd),
      };
    },
  };
}
