// analyze_reference (Bible 6.2): the example video becomes Video DNA with its edit grammar. This file is the pipeline and its
// ports. Each step is a call through a port: the media functions (probe, cuts, frames, timeline), the speech-to-text wrapper,
// the Claude roles (segmenter, genome) through runRole, and the source store. The grammar and the sound measures are code.
//
// Order (Bible 6.2): (1) the reference resolves to a media source; (2) the probe, the timeline, the cuts and the frames at cuts
// plus two per second; (3) speech-to-text; (4) the segmenter; (5) the measured fields of each segment, from the timeline; (6)
// the genome, which reads those segments; (7) the grammar from code, with the captions, zoom and loop readings; (8) the source
// is released and the DNA is built. A stage that cannot measure something fails its gate with the reason. It never stores a
// guess, and it never returns success with a missing field.

import { runRole, type RoleDeps, type RoleOutcome } from "../claude/client.ts";
import { genome, type GenomeAnswer } from "../claude/roles/genome.ts";
import {
  segmenter,
  type SegmenterAnswer,
  type SegmenterSegment,
} from "../claude/roles/segmenter.ts";
import { thresholds } from "../config/thresholds.ts";
import {
  EngineError,
  newId,
  videoDnaSchema,
  type DnaSegment,
  type GateCheck,
  type GateResult,
  type ProductionRequest,
  type VideoDNA,
  type Word,
} from "../contracts/index.ts";
import {
  computeEditGrammar,
  hookPayoffOf,
  sortedCuts,
  type GrammarSegment,
  type MeasuredCaptions,
  type MeasuredZoom,
} from "../edit/grammar.ts";
import { check, gateResult } from "../review/gates/common.ts";
import {
  framesAtCutsAndSamples,
  transcribeMetered,
  type Frame,
  type MediaFunctions,
  type MediaSource,
  type SpeechToText,
  type SpeechToTextConnection,
} from "../media/index.ts";
import { angleBibleEntries } from "./angle-bible.ts";
import { measureSound, type SpeechSpan, type SoundMeasures } from "./beats.ts";
import { copiesTranscript } from "./copy.ts";
import { segmentMeasures, type SegmentMeasures } from "./measure.ts";

export const ANALYZE_STAGE = "analyze_reference";

/**
 * The source store (Bible 5.2, 20.2): the reference as a media source, and its deletion once the analysis ends. The request id names
 * the request the reference belongs to: its brand is the store's key (engine-media-link.ts keeps the same rule).
 */
export type ReferenceSource = {
  /** The reference as bytes the functions can read. not_connected when no store is wired (CLAUDE.md working rule 1). */
  resolve(
    referenceVideo: string,
    organizationId: string,
    requestId: string,
  ): Promise<
    { status: "ready"; source: MediaSource } | { status: "not_connected"; reason: string }
  >;
  /** Deletes any copy of the reference Meridian holds. Called once the analysis ends, pass or fail (Bible 5.2, 6.2 step 7). */
  release(referenceVideo: string, organizationId: string, requestId: string): Promise<void>;
};

/**
 * The speech language the reference is transcribed in. A script request names its script's language, and the vendor is asked for it. A
 * brief has none (contract v8, open point 3), so its language is null: the vendor is asked to detect it (lead decision 2026-10-17), and the
 * detected language is stored in the DNA transcript. A port may still set the language (ReferencePorts.speechLanguage).
 */
export function referenceSpeechLanguageOf(request: ProductionRequest): string | null {
  return request.script?.language ?? null;
}

/**
 * The readings that need frames: captions, zoom and loop (Bible 8.1). Each is null until its reader answers. reasons says why a
 * null reading is null, for the gate's detail (Bible 1: a reason, never a guess).
 */
export type GrammarReadings = {
  captions: MeasuredCaptions | null;
  zoom: MeasuredZoom | null;
  loop: boolean | null;
  reasons?: { captions?: string; zoom?: string; loop?: string; motion?: string };
};

export type ReadingsScope = {
  organizationId: string;
  /** The run's identity: a reader that calls a role needs it for the ledger and the idempotency key (Bible 14.1). */
  requestId: string;
  reservationId: string;
  attempt: number;
  source: MediaSource;
  durationMs: number;
  cutsMs: number[];
  frames: Frame[];
};

export type ReferencePorts = {
  media: MediaFunctions;
  /** The speech-to-text connection (media/stt-connection.ts). Not ready means the stage stops before it spends anything. */
  speech: SpeechToTextConnection;
  /** The vendor's list price per minute (prices.ts). Null refuses the call (Bible 14.1), so the stage stops with unknown_price. */
  sttPricePerMinuteUsd: number | null;
  /** The Claude client's dependencies: the gateway, the ledger, the clock and, optionally, the journal of role calls. */
  roles: RoleDeps;
  source: ReferenceSource;
  /** Captions (OCR), zoom and loop readings. Absent means none is connected, so the grammar fields are unknown. */
  readings?: (scope: ReadingsScope) => Promise<GrammarReadings>;
  /** The DNA id. A test passes a fixed one; production makes a new one. */
  newDnaId?: () => string;
  /**
   * The reference's speech language for speech-to-text (see referenceSpeechLanguageOf). Absent, a script request's language is used
   * and a brief's is null, which asks the vendor to detect it. A port returns the language it knows, or null for detection.
   */
  speechLanguage?: (run: ReferenceRun) => string | null;
};

export type ReferenceRun = {
  organizationId: string;
  requestId: string;
  reservationId: string;
  /** The job's infrastructure attempt, from 1 (Bible 5.1). A retry is a new key, so a stored answer is reused, not paid again. */
  attempt: number;
  /** The gate's subject: the stage job's subject id. */
  subjectId: string;
  request: ProductionRequest;
};

export type ReferenceOutcome =
  /** The stage cannot run: nothing was spent, and the reason says what must be connected. */
  | { status: "not_connected"; reason: string }
  /** The gate, and the DNA when the gate passes. unknown lists every grammar field that could not be measured. */
  | { status: "done"; gate: GateResult; dna: VideoDNA | null; unknown: string[] };

/** A frame as the segmenter reads it: a PNG as a base64 data URL. */
function frameInput(frame: Frame): { atMs: number; imageUrl: string } {
  return {
    atMs: frame.atMs,
    imageUrl: `data:image/png;base64,${Buffer.from(frame.png).toString("base64")}`,
  };
}

/** The answer of a role call, or the reason it was refused. A duplicate with no stored answer is a conflict, never a guess. */
function answerOf<Answer>(outcome: RoleOutcome<Answer>): { value: Answer } | { refused: string } {
  if (outcome.status === "done") return { value: outcome.value };
  if (outcome.status === "refused") return { refused: outcome.reason };
  throw new EngineError(
    "conflict",
    `${outcome.role} was already authorized for this job and no answer is stored; reuse the stored answer`,
    {
      stage: ANALYZE_STAGE,
    },
  );
}

function attemptOf(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new EngineError("invalid_input", "the job attempt must be an integer from 1", {
      stage: ANALYZE_STAGE,
    });
  }
  return attempt;
}

/** A segment with the measured fields the DNA stores (Bible 4.1). */
type MeasuredSegment = { segment: SegmenterSegment; values: SegmentMeasures };

/** Runs the reference analysis (Bible 6.2, steps 1 to 7). See the header for the order. */
export async function analyzeReference(
  run: ReferenceRun,
  ports: ReferencePorts,
): Promise<ReferenceOutcome> {
  if (ports.speech.status === "not_connected")
    return { status: "not_connected", reason: ports.speech.reason };
  const stt: SpeechToText = ports.speech.stt;
  const { request } = run;
  // The speech language, read before anything is measured. Null asks the vendor to detect it (a brief); the result names it.
  const language = ports.speechLanguage ? ports.speechLanguage(run) : referenceSpeechLanguageOf(request);
  const attempt = attemptOf(run.attempt);
  const resolved = await ports.source.resolve(request.format.referenceVideo, run.organizationId, run.requestId);
  if (resolved.status === "not_connected")
    return { status: "not_connected", reason: resolved.reason };
  const source = resolved.source;

  // (2) The probe. A reference whose duration is unknown stops here: nothing else can be measured against it.
  const probe = await ports.media.probe({ source });
  const durationMs = probe.durationMs;
  if (durationMs === null || durationMs <= 0) {
    await ports.source.release(request.format.referenceVideo, run.organizationId, run.requestId);
    return {
      status: "done",
      gate: gateResult("dna", run.subjectId, [
        check("probe_duration", false, {
          detail: "the reference's duration could not be measured",
        }),
      ]),
      dna: null,
      unknown: ["probe_duration"],
    };
  }
  const checks: GateCheck[] = [check("probe_duration", true, { value: durationMs })];
  const unknown: string[] = [];

  const timeline = await ports.media.timeline({ source });
  const cuts = await ports.media.cuts({ source });
  const cutsMs = sortedCuts(durationMs, cuts.cutsMs);
  const { frames } = await framesAtCutsAndSamples(ports.media, {
    source,
    durationMs,
    cutsMs,
    longSidePx: thresholds.claude.visionMaxLongSidePx,
  });

  // (3) Speech-to-text with word timings. The metered wrapper reserves, keys and reconciles the call (Bible 14.1).
  const metered = await transcribeMetered(
    stt,
    { source, durationMs, language, organizationId: run.organizationId },
    {
      store: ports.roles.ledger,
      reservationId: run.reservationId,
      stage: ANALYZE_STAGE,
      pricePerMinuteUsd: ports.sttPricePerMinuteUsd,
      at: ports.roles.now(),
    },
  );
  const words: Word[] = metered.result.words;
  const speech: SpeechSpan[] = words.map((word) => ({ startMs: word.startMs, endMs: word.endMs }));

  // (4) The segmenter: the structure of the example. Its answer refers to the transcript by word id.
  const roleBase = {
    requestId: run.requestId,
    workspaceId: run.organizationId,
    reservationId: run.reservationId,
    attempt,
  };
  const segmented = answerOf<SegmenterAnswer>(
    await runRole(ports.roles, segmenter, {
      ...roleBase,
      input: { durationMs, cutsMs, transcript: words, frames: frames.map(frameInput) },
    }),
  );
  if ("refused" in segmented) {
    checks.push(
      check("segmenter_answered", false, {
        detail: `the segmenter call was refused: ${segmented.refused}`,
      }),
    );
  } else {
    checks.push(check("segmenter_answered", true, { value: segmented.value.segments.length }));
  }
  const segments: SegmenterSegment[] = "value" in segmented ? segmented.value.segments : [];

  // (5) The measured fields of each segment, from the timeline over its span (Bible 6.2 step 2, 4.1).
  const measured: Array<MeasuredSegment | null> = segments.map((segment) => {
    const values = segmentMeasures(segment, timeline);
    return values === null ? null : { segment, values };
  });
  const allMeasured = measured.every((item): item is MeasuredSegment => item !== null);
  checks.push(
    check("segment_measures", segments.length > 0 && allMeasured, {
      detail:
        segments.length === 0
          ? "there are no segments to measure"
          : allMeasured
            ? undefined
            : "a segment has no measured motion, brightness or loudness (the reference has no picture or no audio)",
    }),
  );

  // (6) The genome: named values from the Angle Bible, the transferable genes and the labels to keep out. It reads the measured
  // segments and the transcript. It runs only when every segment has its measures, so it never reads a value that is not measured.
  let genomeAnswer: GenomeAnswer | null = null;
  if (allMeasured && segments.length > 0) {
    const answered = answerOf<GenomeAnswer>(
      await runRole(ports.roles, genome, {
        ...roleBase,
        input: {
          durationMs,
          segments: measured.map((item) => ({
            segId: item!.segment.segId,
            startMs: item!.segment.startMs,
            endMs: item!.segment.endMs,
            shotType: item!.segment.shotType,
            layers: item!.segment.layers,
            ...(item!.segment.beatRole === undefined ? {} : { beatRole: item!.segment.beatRole }),
            ...item!.values,
          })),
          transcript: words,
          angleBible: angleBibleEntries(),
        },
      }),
    );
    if ("refused" in answered) {
      checks.push(
        check("genome_answered", false, {
          detail: `the genome call was refused: ${answered.refused}`,
        }),
      );
    } else {
      genomeAnswer = answered.value;
      checks.push(check("genome_answered", true));
    }
  } else {
    checks.push(
      check("genome_answered", false, { detail: "not run: the segments are not all measured" }),
    );
  }

  // Copy check (Bible 1 principle 4): no layer description may repeat the transcript.
  const copied = segments.some((segment) =>
    Object.values(segment.layers).some(
      (layer) => typeof layer === "string" && copiesTranscript(layer, words),
    ),
  );
  checks.push(
    check("no_copied_content", !copied, {
      detail: copied ? "a layer description repeats the transcript" : undefined,
    }),
  );
  checks.push(
    check("segments_min", segments.length >= thresholds.reference.minSegments, {
      value: segments.length,
      limit: thresholds.reference.minSegments,
    }),
  );
  checks.push(
    check(
      "segments_in_video",
      segments.every((segment) => segment.endMs <= durationMs),
    ),
  );

  // (7) The grammar from code (Bible 8.1). The readings come from their ports when they are wired.
  const readings: GrammarReadings = ports.readings
    ? await ports.readings({
        organizationId: run.organizationId,
        requestId: run.requestId,
        reservationId: run.reservationId,
        attempt,
        source,
        durationMs,
        cutsMs,
        frames,
      })
    : { captions: null, zoom: null, loop: null };
  const grammarSegments: GrammarSegment[] = segments.map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    shotType: segment.shotType,
    ...(segment.beatRole === undefined ? {} : { beatRole: segment.beatRole }),
  }));
  const sound: SoundMeasures | null =
    timeline.audioPresent && timeline.envelope.rms.length > 0
      ? measureSound({
          rms: timeline.envelope.rms,
          stepMs: timeline.envelope.stepMs,
          durationMs,
          speech,
          payoffMs: hookPayoffOf(grammarSegments, cutsMs, durationMs),
        })
      : null;
  const grammar = computeEditGrammar({
    durationMs,
    cutsMs,
    segments: grammarSegments,
    sound,
    loudness: timeline.loudness,
    brightness: timeline.brightness,
    motion: timeline.motion,
    captions: readings.captions,
    zoom: readings.zoom,
    loop: readings.loop,
    reasons: readings.reasons ?? {},
  });
  unknown.push(...grammar.unknown);
  checks.push(
    check("grammar_measured", grammar.unknown.length === 0, {
      detail:
        grammar.unknown.length === 0 ? undefined : `not measured: ${grammar.unknown.join("; ")}`,
    }),
  );
  checks.push(
    check(
      "video_measured",
      timeline.videoPresent && timeline.brightness.length > 0 && timeline.motion.length > 0,
      {
        detail: timeline.videoPresent ? undefined : "the reference has no picture",
      },
    ),
  );
  checks.push(
    check(
      "audio_measured",
      timeline.audioPresent && timeline.loudness.length > 0 && timeline.envelope.rms.length > 0,
      {
        detail: timeline.audioPresent ? undefined : "the reference has no audio",
      },
    ),
  );

  // (8) Release the source, then build the DNA. sourceDeletedAt is the time of the release (Bible 4.1).
  await ports.source.release(request.format.referenceVideo, run.organizationId, run.requestId);
  const sourceDeletedAt = ports.roles.now();

  let dna: VideoDNA | null = null;
  const allSoFar = checks.every((item) => item.pass);
  if (allSoFar && allMeasured && genomeAnswer !== null && grammar.grammar !== null) {
    const dnaSegments: DnaSegment[] = measured.map((item) => {
      const measuredSegment = item!;
      return {
        segId: measuredSegment.segment.segId,
        startMs: measuredSegment.segment.startMs,
        endMs: measuredSegment.segment.endMs,
        wordIds: measuredSegment.segment.wordIds,
        shotType: measuredSegment.segment.shotType,
        layers: measuredSegment.segment.layers,
        ...(measuredSegment.segment.beatRole === undefined
          ? {}
          : { beatRole: measuredSegment.segment.beatRole }),
        motion: measuredSegment.values.motion,
        brightness: measuredSegment.values.brightness,
        loudnessLufs: measuredSegment.values.loudnessLufs,
      };
    });
    const parsed = videoDnaSchema.safeParse({
      schema: "meridian.video_dna/v1",
      videoDnaId: (ports.newDnaId ?? (() => newId("dna_")))(),
      formatId: request.format.formatId,
      sourceRef: request.format.referenceVideo,
      durationMs,
      transcript: { words, language: metered.result.language },
      segments: dnaSegments,
      genome: genomeAnswer.genome,
      editGrammar: grammar.grammar,
      transferable: genomeAnswer.transferable,
      notTransferable: genomeAnswer.notTransferable,
      sourceDeletedAt,
    });
    checks.push(
      check("dna_parses", parsed.success, {
        detail: parsed.success ? undefined : parsed.error.issues[0]?.message,
      }),
    );
    if (parsed.success) dna = parsed.data;
  } else {
    checks.push(
      check("dna_parses", false, { detail: "the DNA is not built: a check above failed" }),
    );
  }

  const passed = checks.every((item) => item.pass) && dna !== null;
  return {
    status: "done",
    gate: gateResult("dna", run.subjectId, checks),
    dna: passed ? dna : null,
    unknown,
  };
}
