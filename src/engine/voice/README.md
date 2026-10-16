# Voice stage (W6): `src/engine/voice/`

Implements Video Engine Bible **6.3** (voice, steps 1 to 5) and the tightener of **11.1**. The stage handler is
`src/engine/jobs/handlers/voice.ts`. Status and the owner's live steps are in `STATUS.md`.

## Files

- `text.ts`: the narration text from the script beats, with the pacing marks (beats and emphasis words). Plain text, because the
  speech route takes plain text.
- `align.ts`: the minimum-edit alignment of the script with the transcript, and the word error rate.
- `timings.ts`: the beat spans of a take. They cover the duration with no gap, and a beat whose words were not said is reported.
- `config.ts`: the pace speeds, the retake limit and the tighten limit (initial values; move to `engine/config`).
- `voice.ts`: `runVoice(run, ports)`, the loop: speak, measure, pace, tighten, transcribe, retake, measure loudness, build the
  track. Speech goes through the asset router; the transcript through `transcribeMetered`; the tightener through `runRole`.

## Rules this folder keeps

- The stage stops before any paid call when speech-to-text is not connected (NOT_CONNECTED), and when the speech route has no
  model (the router's reason). Nothing is spent in either case.
- The TTS timings are never used. Word timings come from the speech-to-text service only.
- A take over `maxMs` is not transcribed. The narration is paced faster twice, then the longest beat is tightened once.
- The tightener keeps every number and emphasis word of the beat, and may not exceed the word target.

## Tests

    NODE_ENV=development node --experimental-strip-types --test "src/engine/voice/**/*.test.ts" "src/engine/jobs/handlers/voice.test.ts"
