// Speech-to-text: transcript validation, the recorded adapter's four outcome classes (success, rate limit, timeout,
// policy refusal), and the budget wrapper. Every call here is replayed; no vendor is called (none is chosen, Bible 20.2).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetReservationFixture } from "../contracts/fixtures/index.ts";
import { EngineError } from "../contracts/errors.ts";
import { wordSchema } from "../contracts/analysis.ts";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import {
  checkBilledUsd,
  estimateSttUsd,
  normaliseTranscript,
  recordedSpeechToText,
  SttCallError,
  sttIdempotencyKey,
  transcribeMetered,
  type SttRequest,
} from "./stt.ts";
import {
  STT_AUDIO_MS,
  STT_WORDS,
  sttNoBillRecording,
  sttOutOfOrderRecording,
  sttPolicyRefusalRecording,
  sttRateLimitThenSuccessRecording,
  sttSuccessRecording,
  sttTimeoutRecording,
} from "../test/fixtures/recorded/stt.ts";

const LANGUAGE = "en";
const REQUEST: SttRequest = {
  source: { kind: "url", url: "https://media.example.com/audio.wav" },
  durationMs: STT_AUDIO_MS,
  language: LANGUAGE,
};
const PRICE_PER_MINUTE = 0.1;
const AT = "2026-10-14T09:00:00.000Z";

function rawWords(overrides: Array<Partial<(typeof STT_WORDS)[number]>>): unknown {
  return {
    language: "en",
    words: STT_WORDS.map((word, i) => ({ ...word, ...(overrides[i] ?? {}) })),
  };
}

async function rejects(promise: Promise<unknown>, kind: string): Promise<EngineError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EngineError, `expected an EngineError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail(`expected ${kind}`);
}

describe("normaliseTranscript (untrusted vendor output)", () => {
  it("turns a valid transcript into words with ids and integer millisecond timings", () => {
    const result = normaliseTranscript(
      { language: "en", words: STT_WORDS },
      { durationMs: STT_AUDIO_MS, language: "en" },
    );
    assert.equal(result.words.length, 7);
    assert.deepEqual(result.words[0], {
      wordId: "w0001",
      text: "Your",
      startMs: 120,
      endMs: 380,
      confidence: 0.98,
    });
    for (const word of result.words) {
      assert.deepEqual(wordSchema.parse(word), word);
    }
  });

  it("accepts an empty transcript (no speech) without inventing words", () => {
    assert.deepEqual(
      normaliseTranscript({ language: "en", words: [] }, { durationMs: 1000, language: "en" })
        .words,
      [],
    );
  });

  it("refuses words out of order, as a provider error that is not retryable", async () => {
    const words = [
      { text: "Your", start: 0.5, end: 0.8, confidence: 0.98 },
      { text: "kitchen", start: 0.2, end: 0.7, confidence: 0.97 },
    ];
    const error = await rejects(
      Promise.resolve().then(() =>
        normaliseTranscript(
          { language: "en", words },
          { durationMs: STT_AUDIO_MS, language: "en" },
        ),
      ),
      "provider",
    );
    assert.equal(error.retryable, false);
    assert.match(error.message, /starts before the word before it/);
  });

  it("refuses a word that ends after the audio, beyond the tolerance", async () => {
    await rejects(
      Promise.resolve().then(() =>
        normaliseTranscript(rawWords([{ end: 5.0 }]), { durationMs: STT_AUDIO_MS, language: "en" }),
      ),
      "provider",
    );
  });

  it("accepts a word that ends within the tolerance after the audio", () => {
    const words = [{ text: "you", start: 2.4, end: 3.0, confidence: 0.9 }];
    assert.equal(
      normaliseTranscript({ language: "en", words }, { durationMs: 2600, language: "en" }).words
        .length,
      1,
    );
  });

  it("refuses a token with a space, a control character or a length over the limit", async () => {
    const cases = ["two words", "bad\u0007char", "x".repeat(65), "   "];
    for (const text of cases) {
      await rejects(
        Promise.resolve().then(() =>
          normaliseTranscript(rawWords([{ text }]), { durationMs: STT_AUDIO_MS, language: "en" }),
        ),
        "provider",
      );
    }
  });

  it("refuses a confidence outside 0 to 1, and a word that does not end after it starts", async () => {
    await rejects(
      Promise.resolve().then(() =>
        normaliseTranscript(rawWords([{ confidence: 1.5 }]), {
          durationMs: STT_AUDIO_MS,
          language: "en",
        }),
      ),
      "provider",
    );
    await rejects(
      Promise.resolve().then(() =>
        normaliseTranscript(rawWords([{ start: 0.5, end: 0.5 }]), {
          durationMs: STT_AUDIO_MS,
          language: "en",
        }),
      ),
      "provider",
    );
  });

  it("refuses a missing field and a non-finite number", async () => {
    await rejects(
      Promise.resolve().then(() =>
        normaliseTranscript(
          { language: "en", words: [{ text: "x", start: 0, end: 1 }] },
          { durationMs: 2000, language: "en" },
        ),
      ),
      "provider",
    );
    await rejects(
      Promise.resolve().then(() =>
        normaliseTranscript(
          { language: "en", words: [{ text: "x", start: Number.NaN, end: 1, confidence: 0.9 }] },
          { durationMs: 2000, language: "en" },
        ),
      ),
      "provider",
    );
  });

  it("refuses a transcript in another language, and accepts a regional tag of the same language", async () => {
    await rejects(
      Promise.resolve().then(() =>
        normaliseTranscript(
          { language: "fr", words: STT_WORDS },
          { durationMs: STT_AUDIO_MS, language: "en" },
        ),
      ),
      "provider",
    );
    assert.equal(
      normaliseTranscript(
        { language: "en-US", words: STT_WORDS },
        { durationMs: STT_AUDIO_MS, language: "en" },
      ).words.length,
      7,
    );
  });

  it("refuses more words than the limit", async () => {
    const words = Array.from({ length: 3001 }, (_, i) => ({
      text: "a",
      start: i,
      end: i + 0.5,
      confidence: 0.9,
    }));
    await rejects(
      Promise.resolve().then(() =>
        normaliseTranscript({ language: "en", words }, { durationMs: 10_000_000, language: "en" }),
      ),
      "provider",
    );
  });
});

describe("checkBilledUsd", () => {
  it("accepts null (not reported) and a USD amount with at most 4 decimals", () => {
    assert.equal(checkBilledUsd(null), null);
    assert.equal(checkBilledUsd(0.0043), 0.0043);
  });

  it("refuses a negative bill, a bill with more than 4 decimals, and a non-number", () => {
    assert.throws(() => checkBilledUsd(-0.01), EngineError);
    assert.throws(() => checkBilledUsd(0.00001), EngineError);
    assert.throws(() => checkBilledUsd("0.01"), EngineError);
  });
});

describe("estimateSttUsd", () => {
  it("prices a call per minute, to 4 decimals", () => {
    assert.equal(estimateSttUsd(60_000, 0.1), 0.1);
    assert.equal(estimateSttUsd(STT_AUDIO_MS, 0.1), 0.0043);
  });

  it("refuses an unknown price (the vendor is not chosen): no estimate, never 0", () => {
    assert.throws(
      () => estimateSttUsd(STT_AUDIO_MS, null),
      (error: unknown) => error instanceof EngineError && error.kind === "unknown_price",
    );
  });

  it("refuses a zero or fractional duration", () => {
    assert.throws(() => estimateSttUsd(0, 0.1), EngineError);
    assert.throws(() => estimateSttUsd(1.5, 0.1), EngineError);
  });
});

describe("recordedSpeechToText: the four outcome classes", () => {
  it("success returns validated words, the bill and the language", async () => {
    const stt = recordedSpeechToText(sttSuccessRecording);
    const result = await stt.transcribe(REQUEST, "stt:key-1");
    assert.equal(result.words.length, 7);
    assert.equal(result.billedUsd, 0.0043);
    assert.equal(result.language, "en");
    assert.deepEqual(stt.calls, ["stt:key-1"]);
  });

  it("a rate limit is a retryable provider error, and the retry with the same key succeeds", async () => {
    const stt = recordedSpeechToText(sttRateLimitThenSuccessRecording);
    const error = await rejects(stt.transcribe(REQUEST, "stt:key-2"), "provider");
    assert.ok(error instanceof SttCallError);
    assert.equal(error.providerKind, "rate_limit");
    assert.equal(error.retryable, true);
    const result = await stt.transcribe(REQUEST, "stt:key-2");
    assert.equal(result.words.length, 7);
    assert.deepEqual(stt.calls, ["stt:key-2", "stt:key-2"]);
  });

  it("a timeout is a retryable provider error", async () => {
    const error = await rejects(
      recordedSpeechToText(sttTimeoutRecording).transcribe(REQUEST, "k"),
      "provider",
    );
    assert.ok(error instanceof SttCallError);
    assert.equal(error.providerKind, "timeout");
    assert.equal(error.retryable, true);
  });

  it("a policy refusal is not retryable: the input must change", async () => {
    const error = await rejects(
      recordedSpeechToText(sttPolicyRefusalRecording).transcribe(REQUEST, "k"),
      "provider",
    );
    assert.ok(error instanceof SttCallError);
    assert.equal(error.providerKind, "content_policy");
    assert.equal(error.retryable, false);
  });

  it("a recording that has run out is an internal error, never a guessed transcript", async () => {
    const stt = recordedSpeechToText(sttSuccessRecording);
    await stt.transcribe(REQUEST, "k1");
    await rejects(stt.transcribe(REQUEST, "k2"), "internal");
  });

  it("rejects a recorded transcript that fails validation, so nothing unvalidated is stored", async () => {
    await rejects(
      recordedSpeechToText(sttOutOfOrderRecording).transcribe(REQUEST, "k"),
      "provider",
    );
  });
});

describe("transcribeMetered: reserve, authorise with a key, call, reconcile", () => {
  async function store(): Promise<LedgerStore> {
    const ledger = memoryLedgerStore();
    await ledger.createReservation(budgetReservationFixture);
    return ledger;
  }

  function meter(
    ledger: LedgerStore,
    overrides: Partial<{ pricePerMinuteUsd: number | null; at: string }> = {},
  ) {
    return {
      store: ledger,
      reservationId: budgetReservationFixture.reservationId,
      stage: "analyze_reference",
      pricePerMinuteUsd: PRICE_PER_MINUTE,
      at: AT,
      ...overrides,
    };
  }

  it("reconciles the ledger to the vendor's bill and records the estimate it held", async () => {
    const ledger = await store();
    const stt = recordedSpeechToText(sttSuccessRecording);
    const outcome = await transcribeMetered(stt, REQUEST, meter(ledger));
    assert.equal(outcome.result.words.length, 7);
    assert.equal(outcome.estimateUsd, 0.0043);
    assert.equal(outcome.actualUsd, 0.0043);
    assert.equal(outcome.settled, true);
    const entries = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.idempotencyKey, outcome.idempotencyKey);
    assert.equal(entries[0]?.actualUsd, 0.0043);
  });

  it("leaves the cost unknown when the vendor reports no bill: the ledger holds the estimate with no actual (contract v6)", async () => {
    const ledger = await store();
    const outcome = await transcribeMetered(
      recordedSpeechToText(sttNoBillRecording),
      REQUEST,
      meter(ledger),
    );
    assert.equal(outcome.actualUsd, null);
    assert.equal(outcome.settled, false);
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.reservedUsd, outcome.estimateUsd, "the call holds its estimate");
    assert.equal(entry?.actualUsd, undefined, "the estimate is never written as the actual (contract v6)");
    assert.equal(entry?.settlement, undefined);
  });

  it("refuses a second transcription of the same input once it is reconciled, and does not call the vendor", async () => {
    const ledger = await store();
    const stt = recordedSpeechToText({
      ...sttSuccessRecording,
      responses: [...sttSuccessRecording.responses, ...sttSuccessRecording.responses],
    });
    await transcribeMetered(stt, REQUEST, meter(ledger));
    await rejects(transcribeMetered(stt, REQUEST, meter(ledger)), "conflict");
    assert.equal(stt.calls.length, 1, "the vendor was called once");
  });

  it("does not send a failed call again under its key: it stays unsettled until the operator settles it (contract v6)", async () => {
    const ledger = await store();
    const stt = recordedSpeechToText(sttRateLimitThenSuccessRecording);
    const key = sttIdempotencyKey(stt, REQUEST);
    await rejects(transcribeMetered(stt, REQUEST, meter(ledger)), "provider");
    const entriesAfterFailure = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entriesAfterFailure[0]?.settlement, undefined, "the hold stays until the call is settled");

    await rejects(transcribeMetered(stt, REQUEST, meter(ledger)), "conflict");
    assert.deepEqual(stt.calls, [key], "the vendor was called once: the unsettled call is not sent again");
  });

  it("refuses the call when the price is unknown: nothing is held and the vendor is not called", async () => {
    const ledger = await store();
    const stt = recordedSpeechToText(sttSuccessRecording);
    await rejects(
      transcribeMetered(stt, REQUEST, meter(ledger, { pricePerMinuteUsd: null })),
      "unknown_price",
    );
    assert.equal((await ledger.listEntries(budgetReservationFixture.reservationId)).length, 0);
    assert.equal(stt.calls.length, 0);
  });

  it("refuses the call when the reservation is paused", async () => {
    const ledger = memoryLedgerStore();
    await ledger.createReservation({
      ...budgetReservationFixture,
      state: "paused",
      pausedReason: "budget test",
    });
    const stt = recordedSpeechToText(sttSuccessRecording);
    await rejects(transcribeMetered(stt, REQUEST, meter(ledger)), "conflict");
    assert.equal(stt.calls.length, 0);
  });

  it("refuses the same key with a different payload (a price change between calls), without calling the vendor", async () => {
    const ledger = await store();
    const stt = recordedSpeechToText({
      ...sttRateLimitThenSuccessRecording,
      responses: [
        sttRateLimitThenSuccessRecording.responses[0]!,
        sttSuccessRecording.responses[0]!,
      ],
    });
    await rejects(transcribeMetered(stt, REQUEST, meter(ledger)), "provider");
    await rejects(
      transcribeMetered(stt, REQUEST, meter(ledger, { pricePerMinuteUsd: 0.2 })),
      "conflict",
    );
    assert.equal(stt.calls.length, 1);
  });

  it("a policy refusal leaves its hold on the ledger, not released, because the vendor may have billed it", async () => {
    const ledger = await store();
    await rejects(
      transcribeMetered(recordedSpeechToText(sttPolicyRefusalRecording), REQUEST, meter(ledger)),
      "provider",
    );
    const [entry] = await ledger.listEntries(budgetReservationFixture.reservationId);
    assert.equal(entry?.actualUsd, undefined);
  });

  it("gives a different idempotency key for a different source, so two inputs never share a bill", () => {
    const stt = recordedSpeechToText(sttSuccessRecording);
    const other: SttRequest = {
      ...REQUEST,
      source: { kind: "url", url: "https://media.example.com/other.wav" },
    };
    assert.notEqual(sttIdempotencyKey(stt, REQUEST), sttIdempotencyKey(stt, other));
  });
});
