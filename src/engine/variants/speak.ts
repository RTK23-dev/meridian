// The beat-scoped voice call of a variant (Video Engine Bible 6.3, 6.13). Only the lines the variant changed are spoken. The voice stage
// (voice/voice.ts, runVoice) runs on a request whose script is those beats, with their new text, so the speech, the timing, the
// loudness and the gate are the voice stage's own. The track it returns covers those beats only: its beatSpans start at zero.
//
// Not solved here: an EDL has one voice clip (contracts/edl.ts), so a segment cannot yet be placed in a variant's EDL. Until an audio
// splice exists, a variant whose voice is a segment is not assembled (variants/STATUS.md).

import { EngineError, type ProductionRequest, type ScriptBeat, type VoiceKit } from "../contracts/index.ts";
import { runVoice, type VoiceOutcome, type VoicePorts, type VoiceRun } from "../voice/voice.ts";

const STAGE = "variants";

/** One beat's new text. The beat must be one of the request's beats, and each beat may appear once. */
export type ChangedLine = { beatId: string; text: string };

export type SpeakChangedRun = {
  organizationId: string;
  requestId: string;
  reservationId: string;
  attempt: number;
  subjectId: string;
  /** The master request: its beats give the order, and its maxMs bounds the narration. */
  request: ProductionRequest;
  /** The language the lines are spoken in: the request's own, or the variant's for a language change. */
  language: string;
  /** The voice kit that speaks: the persona's voice for a persona change, else the page's. */
  voice: VoiceKit;
  /** Approved claim texts the narration may make. */
  claims: string[];
  lines: ChangedLine[];
};

/** Runs the voice stage on one run. The default is runVoice; a test passes a recorded runner. */
export type VoiceRunner = (run: VoiceRun, ports: VoicePorts) => Promise<VoiceOutcome>;

/**
 * The request the voice stage speaks for a changed set of lines: the beats that changed, in script order, with their new text. An
 * emphasis word survives only when the new text still contains it. Pure.
 */
export function changedRequestFor(run: Pick<SpeakChangedRun, "request" | "language" | "lines">): ProductionRequest {
  const textOf = new Map<string, string>();
  for (const line of run.lines) {
    if (textOf.has(line.beatId)) {
      throw new EngineError("invalid_input", `beat ${line.beatId} has two lines in one variant`, { stage: STAGE });
    }
    textOf.set(line.beatId, line.text);
  }
  const known = new Set(run.request.script.beats.map((beat) => beat.beatId));
  for (const beatId of textOf.keys()) {
    if (!known.has(beatId)) throw new EngineError("invalid_input", `beat ${beatId} is not a beat of the request`, { stage: STAGE });
  }
  const beats: ScriptBeat[] = run.request.script.beats
    .filter((beat) => textOf.has(beat.beatId))
    .map((beat) => {
      const text = textOf.get(beat.beatId) ?? beat.text;
      return { ...beat, text, emphasis: (beat.emphasis ?? []).filter((word) => text.includes(word)) };
    });
  if (beats.length === 0) throw new EngineError("invalid_input", "a variant speaks at least one changed line", { stage: STAGE });
  return { ...run.request, script: { language: run.language, beats } };
}

/**
 * Speaks only the changed lines (Bible 6.13: voice is regenerated for changed lines only). It refuses an empty set of lines before
 * anything is called. The outcome is the voice stage's: not_connected, or done with a gate and, when it passes, the track.
 */
export async function speakChangedLines(ports: VoicePorts, run: SpeakChangedRun, runner: VoiceRunner = runVoice): Promise<VoiceOutcome> {
  if (run.lines.length === 0) throw new EngineError("invalid_input", "a voice call needs at least one changed line", { stage: STAGE });
  const request = changedRequestFor(run);
  return runner(
    {
      organizationId: run.organizationId,
      requestId: run.requestId,
      reservationId: run.reservationId,
      attempt: run.attempt,
      subjectId: run.subjectId,
      request,
      voice: run.voice,
      claims: run.claims,
    },
    ports,
  );
}
