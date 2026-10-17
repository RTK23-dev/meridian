// The voice call of a generation variant (Video Engine Bible 6.3, 6.13). A variant speaks its own full script: every beat, with the lines the
// writer changed in place of the master's (variants/work.ts). The voice stage (voice/voice.ts, runVoice) runs on that request, so the
// speech, the timing, the loudness and the gate are the voice stage's own. The track covers every beat, and its beatSpans start at zero.
//
// Deliberate deviation (variants/STATUS.md): Bible 6.13 asks for the changed lines only. An EDL holds one voice clip and there is no
// audio splice yet, so the variant's track is re-spoken whole. The cost is the speech of the unchanged beats, and it is on the ledger.
//
// The speech is cached and ledgered under its voice: the asset router's cache key names the voice for a speech spec (assets/cache.ts,
// routeCacheKey). The same text in another voice is a new call, and the same voice again is a hit. Nothing here scopes the call further.

import { EngineError, type ProductionRequest, type VoiceKit } from "../contracts/index.ts";
import { runVoice, type VoiceOutcome, type VoicePorts, type VoiceRun } from "../voice/voice.ts";
import { variantScriptFor } from "./work.ts";
import type { ScriptBody } from "../script/resolve.ts";

/** One variant's voice call: the master request, the lines the writer changed, and the voice that speaks. */
export type VariantSpeech = {
  organizationId: string;
  requestId: string;
  reservationId: string;
  /** The job's infrastructure attempt, from 1 (Bible 5.1). */
  attempt: number;
  /** The variant's job subject (variants/work.ts). It names the gate of the call. */
  subject: string;
  /** The master request: its maxMs bounds the narration, and its voice page names the speech. */
  request: ProductionRequest;
  /** The master's words (script/resolve.ts): its beats give the order, and the variant's lines replace the beats they change. */
  script: ScriptBody;
  /** The language the lines are spoken in: the request's own, or the variant's for a language change. */
  language: string;
  /** The voice kit that speaks: the persona's voice for a persona change, else the page's. */
  voice: VoiceKit;
  /** Approved claim texts the narration may make. */
  claims: string[];
  /** The changed lines, by beat. Empty for a persona change, which speaks the master's own text in the persona's voice. */
  lines: { beatId: string; text: string }[];
};

/**
 * Runs the voice stage on one run. Its ports are absent when no speech route is wired: the runner then refuses before any call. The
 * default is runVoice; a test passes a recorded runner.
 */
export type VoiceRunner = (run: VoiceRun, ports: VoicePorts | undefined) => Promise<VoiceOutcome>;

/** The default runner: the voice stage over its ports. Without ports it refuses (NOT_CONNECTED), before any call. */
export const runVoiceOverPorts: VoiceRunner = async (run, ports) => {
  if (ports === undefined) {
    throw new EngineError("config", "NOT_CONNECTED: the voice stage's ports (speech route, speech-to-text, media, audio) are not wired", {
      stage: "variants",
    });
  }
  return runVoice(run, ports);
};

/**
 * Speaks one variant's full script (Bible 6.13, the deviation above). The outcome is the voice stage's: not_connected, or done with a
 * gate and, when it passes, the track. A line that names no beat of the script is refused by variantScriptFor, before any call.
 */
export async function speakVariantScript(
  ports: VoicePorts | undefined,
  run: VariantSpeech,
  runner: VoiceRunner = runVoiceOverPorts,
): Promise<VoiceOutcome> {
  const script = variantScriptFor({ script: run.script, language: run.language, lines: run.lines });
  return runner(
    {
      organizationId: run.organizationId,
      requestId: run.requestId,
      reservationId: run.reservationId,
      attempt: run.attempt,
      subjectId: run.subject,
      request: run.request,
      script,
      voice: run.voice,
      claims: run.claims,
    },
    ports,
  );
}
