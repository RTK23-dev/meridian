// The voice stage (Bible 6.3): our narration, timed. The text is built from the script beats with their pacing marks (text.ts).
// The narration is spoken through the asset router (the speech route), its duration and loudness are measured on the audio, and
// the speech-to-text service gives the word timings. TTS timings are never trusted (Bible 6.3).
//
// The loop, in order:
// 1. Speech-to-text must be connected. If not, the stage stops before the first paid call (NOT_CONNECTED).
// 2. Speak the text at the normal pace. Measure its duration (probe) before anything else.
// 3. Over maxMs: speak it at the next faster pace (voiceConfig.paceSpeeds, one try each). Still over: the tightener shortens the
//    longest beat once, without changing its numbers, emphasis or claims, and the narration is spoken again at the fastest pace.
//    Still over: the gate fails with the length.
// 4. Within maxMs: transcribe. A word error rate above thresholds.voice.wordErrorRateMax.value, or a script word the speech did not say,
//    is a retake of the same text (once). A second mismatch fails the gate.
// 5. Measure the integrated loudness. Build the beat spans from the aligned words. The gate checks the length, the clarity, the
//    loudness and the span coverage.
//
// Every paid call goes through the router (speech) or the metered wrapper (speech-to-text), and the Claude role goes through
// runRole. Nothing here reads a key or calls the network.

import { runRole, type RoleDeps } from "../claude/client.ts";
import { tightener, type TightenerAnswer } from "../claude/roles/tightener.ts";
import { thresholds } from "../config/thresholds.ts";
import {
  EngineError,
  encodeUlid,
  newId,
  type GateCheck,
  type GateResult,
  type ProductionRequest,
  type ScriptBeat,
  type VoiceKit,
  type VoiceTrack,
  type Word,
} from "../contracts/index.ts";
import { contentHash } from "../contracts/hash.ts";
import { gateResult, check } from "../review/gates/common.ts";
import type { AssetRouter, ProduceOutcome } from "../assets/router.ts";
import { notConnectedReason, type SpeechToTextConnection } from "../media/stt-connection.ts";
import { transcribeMetered, type MediaFunctions, type SpeechToText } from "../media/index.ts";
import { wordTokens } from "../analyze/copy.ts";
import { alignTokens } from "./align.ts";
import { buildVoiceText, scriptTokens } from "./text.ts";
import { beatSpansOf, type BeatSpan } from "./timings.ts";
import { voiceConfig } from "./config.ts";

export const VOICE_STAGE = "voice";

export type VoicePorts = {
  /** The asset router. Its speech route decides the provider and the model (config/routes.ts); with no model it is not connected. */
  router: AssetRouter;
  /** The speech-to-text connection (media/stt-connection.ts). Not ready means the stage stops before any paid call. */
  speech: SpeechToTextConnection;
  /** The vendor's list price per minute, or null, which refuses the transcription (Bible 14.1). */
  sttPricePerMinuteUsd: number | null;
  /** The media functions: the probe and the loudness of each take. */
  media: MediaFunctions;
  /** The Claude client's dependencies (the tightener runs through runRole) and the ledger and clock of the metered calls. */
  roles: RoleDeps;
  /** Reads the bytes of a take from the store the router wrote it to. Not wired: the stage cannot measure a take, and it fails. */
  loadAudio: (uri: string, organizationId: string) => Promise<Uint8Array<ArrayBuffer>>;
};

export type VoiceRun = {
  organizationId: string;
  requestId: string;
  reservationId: string;
  /** The job's infrastructure attempt, from 1 (Bible 5.1). */
  attempt: number;
  subjectId: string;
  request: ProductionRequest;
  /** The page's voice kit: its provider's voice id is what the speech route speaks with. */
  voice: VoiceKit;
  /** Approved claim texts the narration may make (the product kit's claims for the request). The tightener keeps their numbers. */
  claims: string[];
};

export type VoiceResult = {
  gate: GateResult;
  /** The track when the gate passes. Its audio is the take the router wrote. */
  track: VoiceTrack | null;
};

export type VoiceOutcome =
  { status: "not_connected"; reason: string } | ({ status: "done" } & VoiceResult);

/** The narration's spec id is random; the cache and the ledger key on the spec's content, which is stable. */
function narrationShotId(requestId: string): string {
  const digest = contentHash({ requestId, stage: VOICE_STAGE }).slice(
    "sha256:".length,
    "sha256:".length + 20,
  );
  return `shot_${encodeUlid(0, BigInt(`0x${digest}`))}`;
}

/** A word count of a beat, for the longest-beat choice. */
function wordCount(text: string): number {
  return wordTokens(text).length;
}

type Take = {
  uri: string;
  providerId: string;
  costUsd: number;
  costIsEstimate: boolean;
  ledgerEntryId: string | null;
};

/** A take as the router reports it, or the reason the take is not available (a gate failure or a stop). */
type Spoken =
  | { kind: "take"; take: Take }
  | { kind: "stop"; outcome: VoiceOutcome }
  | { kind: "refused"; detail: string };

async function speak(
  ports: VoicePorts,
  run: VoiceRun,
  text: string,
  speed: number,
  seed: number,
): Promise<Spoken> {
  const report = await ports.router.produce({
    spec: {
      schema: "meridian.asset_spec/v1",
      specId: newId("asp_"),
      shotId: narrationShotId(run.requestId),
      modelClass: "tts",
      prompt: text,
      refs: [],
      durationMs: run.request.constraints.maxMs,
      aspect: "9:16",
      width: 1080,
      height: 1920,
      seed,
      takes: 1,
    },
    workspaceId: run.organizationId,
    requestId: run.requestId,
    reservationId: run.reservationId,
    stage: VOICE_STAGE,
    voiceId: run.voice.providerVoiceId,
    speechSpeed: speed,
  });
  return interpret(report.outcome);
}

/** Maps the router's outcome. Only a done take is a take; a refusal of the content is a gate failure; the rest stop the stage. */
function interpret(outcome: ProduceOutcome): Spoken {
  switch (outcome.status) {
    case "done":
      return {
        kind: "take",
        take: {
          uri: outcome.asset.uri,
          providerId: outcome.asset.providerId,
          costUsd: outcome.asset.costUsd,
          costIsEstimate: outcome.asset.costIsEstimate,
          ledgerEntryId: outcome.asset.ledgerEntryId,
        },
      };
    case "not_connected":
      return {
        kind: "stop",
        outcome: {
          status: "not_connected",
          reason: notConnectedReason(
            `the speech route is not connected: ${outcome.reasons.join("; ")}`,
          ),
        },
      };
    case "failed":
      return {
        kind: "refused",
        detail: `the speech provider refused the narration (${outcome.error.kind}): ${outcome.error.message}`,
      };
    case "refused":
      throw new EngineError(
        "conflict",
        `the budget refused the narration call: ${outcome.reasons.join("; ")}`,
        { stage: VOICE_STAGE },
      );
    case "queued":
      throw new EngineError(
        "provider",
        `the speech concurrency bucket is full: ${outcome.reasons.join("; ")}`,
        { stage: VOICE_STAGE, retryable: true },
      );
    case "duplicate":
      throw new EngineError(
        "conflict",
        `the narration call ${outcome.ledgerEntryId} was already authorized, and no take is stored for it`,
        { stage: VOICE_STAGE },
      );
    case "unavailable":
      throw new EngineError(
        "provider",
        `no speech target produced a take: ${outcome.reasons.join("; ")}`,
        { stage: VOICE_STAGE, retryable: true },
      );
  }
}

/** The longest beat by words, the first one on a tie. Undefined for an empty script. */
function longestBeat(beats: readonly ScriptBeat[]): ScriptBeat | undefined {
  let best: ScriptBeat | undefined;
  for (const beat of beats) {
    if (best === undefined || wordCount(beat.text) > wordCount(best.text)) best = beat;
  }
  return best;
}

/** Runs the voice stage (Bible 6.3). */
export async function runVoice(run: VoiceRun, ports: VoicePorts): Promise<VoiceOutcome> {
  if (ports.speech.status === "not_connected")
    return { status: "not_connected", reason: ports.speech.reason };
  const stt: SpeechToText = ports.speech.stt;
  const maxMs = run.request.constraints.maxMs;
  const language = run.request.script.language;
  const checks: GateCheck[] = [];

  let beats: ScriptBeat[] = [...run.request.script.beats];
  let speed = 1;
  let paceTries = 0;
  let tightened = 0;
  let retakes = 0;
  let seed = 0;

  for (;;) {
    const text = buildVoiceText(beats).text;
    const spoken = await speak(ports, run, text, speed, seed);
    if (spoken.kind === "stop") return spoken.outcome;
    if (spoken.kind === "refused") {
      checks.push(check("speech_accepted", false, { detail: spoken.detail }));
      return { status: "done", gate: gateResult("voice", run.subjectId, checks), track: null };
    }
    const bytes = await ports.loadAudio(spoken.take.uri, run.organizationId);
    const probe = await ports.media.probe({ source: { kind: "bytes", bytes } });
    const durationMs = probe.durationMs;
    if (durationMs === null || durationMs <= 0) {
      checks.push(
        check("duration_measured", false, { detail: "the take's duration could not be measured" }),
      );
      return { status: "done", gate: gateResult("voice", run.subjectId, checks), track: null };
    }

    // Length first (Bible 6.3 step 5): a take over maxMs is not transcribed. It is paced faster, then tightened.
    if (durationMs > maxMs) {
      if (paceTries < voiceConfig.paceSpeeds.length) {
        speed = voiceConfig.paceSpeeds[paceTries] ?? speed;
        paceTries += 1;
        continue;
      }
      const longest = longestBeat(beats);
      const words = longest === undefined ? 0 : wordCount(longest.text);
      if (longest !== undefined && tightened < voiceConfig.tightenMax && words >= 2) {
        // The target keeps the same share of the beat as the overrun needs, and is always shorter than the beat.
        const targetWords = Math.min(
          words - 1,
          Math.max(1, Math.floor((words * maxMs) / durationMs)),
        );
        const answered = await runRole(ports.roles, tightener, {
          requestId: run.requestId,
          workspaceId: run.organizationId,
          reservationId: run.reservationId,
          attempt: run.attempt,
          input: {
            beatId: longest.beatId,
            text: longest.text.trim(),
            emphasis: longest.emphasis ?? [],
            claims: run.claims,
            targetWords,
          },
        });
        tightened += 1;
        if (answered.status !== "done") {
          checks.push(
            check("tightener_answered", false, {
              detail: `the tightener did not answer (${answered.status})`,
            }),
          );
          return { status: "done", gate: gateResult("voice", run.subjectId, checks), track: null };
        }
        const replacement: TightenerAnswer = answered.value;
        beats = beats.map((beat) =>
          beat.beatId === longest.beatId ? { ...beat, text: replacement.text } : beat,
        );
        continue;
      }
      checks.push(
        check("duration_within_max", false, {
          value: durationMs,
          limit: maxMs,
          detail: `the narration is ${durationMs} ms, over maxMs ${maxMs} ms after the faster paces and the tightening`,
        }),
      );
      return { status: "done", gate: gateResult("voice", run.subjectId, checks), track: null };
    }

    // Transcript (Bible 6.3 step 3): the speech-to-text gives the word timings.
    const metered = await transcribeMetered(
      stt,
      { source: { kind: "bytes", bytes }, durationMs, language },
      {
        store: ports.roles.ledger,
        reservationId: run.reservationId,
        stage: VOICE_STAGE,
        pricePerMinuteUsd: ports.sttPricePerMinuteUsd,
        at: ports.roles.now(),
      },
    );
    const heard: Word[] = metered.result.words;
    const scriptWords = scriptTokens(beats);
    const heardTokens = heard.flatMap((word, wordIndex) =>
      wordTokens(word.text).map(() => wordIndex),
    );
    const heardText = heard.flatMap((word) => wordTokens(word.text));
    const alignment = alignTokens(scriptWords.tokens, heardText);
    const mismatch =
      alignment.wordErrorRate > thresholds.voice.wordErrorRateMax.value ||
      alignment.deletedScript.length > 0;
    if (mismatch) {
      if (retakes < voiceConfig.retakesMax) {
        retakes += 1;
        seed += 1;
        continue;
      }
      checks.push(
        check("transcript_matches_script", false, {
          value: alignment.wordErrorRate,
          limit: thresholds.voice.wordErrorRateMax.value,
          detail: `the transcript differs from the script: word error rate ${alignment.wordErrorRate.toFixed(4)}, ${alignment.deletedScript.length} script word(s) not said, after a retake`,
        }),
      );
      return { status: "done", gate: gateResult("voice", run.subjectId, checks), track: null };
    }

    // Loudness (Bible 6.3 step 4). A take with no loudness is not a track.
    const loudness = await ports.media.loudness({ source: { kind: "bytes", bytes } });
    const lufs = loudness.integratedLufs;

    const spans = beatSpansOf({
      beatIds: beats.map((beat) => beat.beatId),
      tokenCounts: scriptWords.perBeat,
      alignment,
      heardTokenWord: heardTokens,
      words: heard,
      durationMs,
    });
    checks.push(
      check("duration_within_max", durationMs <= maxMs, { value: durationMs, limit: maxMs }),
    );
    checks.push(
      check("transcript_matches_script", true, {
        value: alignment.wordErrorRate,
        limit: thresholds.voice.wordErrorRateMax.value,
      }),
    );
    checks.push(
      check("lufs_measured", lufs !== null, {
        detail:
          lufs === null
            ? "the loudness of the take is not measurable (silence or no audio)"
            : undefined,
        value: lufs ?? undefined,
      }),
    );
    checks.push(
      check("beats_have_words", spans.problems.length === 0, {
        detail: spans.problems.length === 0 ? undefined : spans.problems.join("; "),
      }),
    );
    const covered =
      spans.spans.length === beats.length &&
      spans.spans[0]?.startMs === 0 &&
      spans.spans[spans.spans.length - 1]?.endMs === durationMs;
    checks.push(
      check("beat_spans_cover_duration", covered, {
        detail: covered
          ? undefined
          : "the beat spans do not cover the audio from 0 to its duration",
      }),
    );
    const gate = gateResult("voice", run.subjectId, checks);
    if (!gate.pass || lufs === null) {
      return { status: "done", gate, track: null };
    }
    const track = buildTrack(run, spoken.take, durationMs, lufs, heard, spans.spans);
    return { status: "done", gate, track };
  }
}

/** The track: our narration with its measured duration, loudness, transcript words and beat spans (Bible 4.2). */
function buildTrack(
  run: VoiceRun,
  take: Take,
  durationMs: number,
  lufs: number,
  words: Word[],
  beatSpans: BeatSpan[],
): VoiceTrack {
  const id = contentHash({ requestId: run.requestId, audioUri: take.uri }).slice(
    "sha256:".length,
    "sha256:".length + 32,
  );
  return {
    schema: "meridian.voice_track/v1",
    voiceTrackId: `vt_${id}`,
    requestId: run.requestId,
    voiceId: run.request.page.voiceId,
    provider: take.providerId,
    audioUri: take.uri,
    durationMs,
    lufs,
    words,
    beatSpans,
  };
}
