// Speech-to-text (Bible 6.2 step 3, 6.3 step 3, 10.3, 20.2): the interface, the validation every vendor's answer must pass,
// the metered wrapper, and recordedSpeechToText, which replays recorded responses for tests. The Deepgram adapter is in
// stt-deepgram.ts. Production code must not use recordedSpeechToText.

import { createHash } from "node:crypto";
import { z } from "zod";
import { authorizeCall } from "../budget/reserve.ts";
import { confirmAbsentCall, reconcileCall } from "../budget/reconcile.ts";
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
  /**
   * The script or reference language, for example "en". Null asks the vendor to detect it (a brief's reference, lead decision 2026-10-17):
   * the transcript then names the language it detected, and that is the language of the result.
   */
  language: string | null;
  /**
   * The workspace the call is for. A vendor that keys its calls to a workspace (Deepgram: its key and its project) reads it here. Null
   * or absent means no workspace is in scope, and such a vendor is not connected. It is not part of the idempotency key: the ledger is
   * per reservation, and a reservation belongs to one workspace.
   */
  organizationId?: string | null;
};

export type SttResult = {
  /** Words with ids and integer millisecond timings, validated against the Word contract. */
  words: Word[];
  language: string;
  /** The vendor's bill for the call, or null when the vendor did not report one. */
  billedUsd: number | null;
  /**
   * Why no bill is recorded, when none is (the bill lookup failed or its answer was not usable). The transcript is still valid, and
   * the call stays held (contract v6). Absent when a bill is recorded.
   */
  billNote?: string;
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
  request: { durationMs: number; language: string | null },
): { words: Word[]; language: string } {
  const parsed = rawTranscriptSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw invalidTranscript(
      first ? `${first.path.map(String).join(".")}: ${first.message}` : "unreadable shape",
    );
  }
  // With no requested language (detection), the vendor's detected language is the result's; with one, it must match the request.
  if (request.language !== null && primaryLanguage(parsed.data.language) !== primaryLanguage(request.language)) {
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

/**
 * A refusal the vendor made before any work: its input was rejected, so no bill can follow. Contract v6 settles such a call as
 * confirmed absent. A rate limit, a timeout and a server error are not in this set: the vendor may have billed them.
 */
export function isRefusalBeforeWork(error: ProviderError): boolean {
  return error.kind === "invalid_input" || error.kind === "content_policy";
}

/** A failed call, typed. retryable comes from the vendor's classification (rate limit, timeout and server errors retry). */
export class SttCallError extends EngineError {
  providerKind: ProviderError["kind"];
  /**
   * True when the vendor refused the call before any work (contract v6): the wrapper then settles the call as confirmed absent, so
   * the next attempt needs a new key. False for every other failure, whose hold stays until the operator settles it.
   */
  refusedBeforeWork: boolean;

  constructor(error: ProviderError, stage: string = STAGE, refusedBeforeWork: boolean = false) {
    super("provider", `speech-to-text ${error.kind}: ${error.message}`, {
      retryable: error.retryable,
      stage,
    });
    this.name = "SttCallError";
    this.providerKind = error.kind;
    this.refusedBeforeWork = refusedBeforeWork;
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
 * The key of the n-th attempt at one input. The first attempt uses the input's key. A later attempt, made after the vendor refused
 * the input before any work (settled confirmed absent), adds ":a<n>", so it is a new key and the ledger does not treat it as a repeat.
 */
export function attemptKey(baseKey: string, attempt: number): string {
  return attempt === 1 ? baseKey : `${baseKey}:a${attempt}`;
}

/**
 * The key a call is authorised under. A key whose call the vendor refused before any work is confirmed absent (contract v6), so the
 * next attempt takes the next attempt key. A key whose call is unsettled or billed is returned as it is: authorisation then refuses it
 * as a repeat, so nothing is sent twice. Past maxRefusedAttempts refusals the input is named and the call is stopped.
 */
async function nextAttemptKey(store: LedgerStore, baseKey: string): Promise<string> {
  const limit = mediaConfig.speechToText.maxRefusedAttempts;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const key = attemptKey(baseKey, attempt);
    const row = await store.getEntryByKey(key);
    if (row === null || row.settlement !== "confirmed_absent") {
      return key;
    }
  }
  throw new EngineError(
    "conflict",
    `speech-to-text input was refused before any work ${limit} times (${baseKey}): change the input before it is sent again`,
    { stage: STAGE, retryable: false },
  );
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
  /** Why no bill is recorded, when the vendor's bill could not be read (SttResult.billNote). */
  billNote?: string;
};

/**
 * Runs one transcription with its budget: estimate, authorise against the reservation with an idempotency key, call the
 * vendor, then settle to the vendor's bill. With no bill the call stays held and its cost unknown; nothing is estimated (contract v6).
 * - A key already on the ledger is never sent again. A settled one is refused and its stored transcript is reused; an unsettled one
 *   (the last call failed or returned no bill) waits to be settled, because the vendor may have billed it (contract v6).
 * - A refusal the vendor made before any work (SttCallError.refusedBeforeWork: a rejected input, or a rejected key) is settled as
 *   confirmed absent, with a hold of zero. The next attempt under the same input uses a new attempt key (nextAttemptKey).
 * - Any other failed call leaves its hold in place. It is not released here, because the vendor may have billed the call.
 */
export async function transcribeMetered(
  stt: SpeechToText,
  request: SttRequest,
  meter: SttMeter,
): Promise<MeteredSttResult> {
  const estimateUsd = estimateSttUsd(request.durationMs, meter.pricePerMinuteUsd, meter.stage);
  const idempotencyKey = await nextAttemptKey(meter.store, sttIdempotencyKey(stt, request));
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

  let result: SttResult;
  try {
    result = await stt.transcribe(request, idempotencyKey);
  } catch (error) {
    // Contract v6 (settlement): a refusal made before any work cannot have been billed, so the call is settled as confirmed absent.
    // Every other failure keeps its hold, because the vendor may have billed it.
    if (error instanceof SttCallError && error.refusedBeforeWork) {
      await confirmAbsentCall(meter.store, { idempotencyKey, evidence: error.message });
    }
    throw error;
  }
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
    ...(result.billNote === undefined ? {} : { billNote: result.billNote }),
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
        throw new SttCallError(next.error, STAGE, isRefusalBeforeWork(next.error));
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
