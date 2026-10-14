# Reference analysis (W6): `src/engine/analyze/`

Implements Video Engine Bible **6.2** (analyze_reference, steps 1 to 7), **8.1** (the edit grammar, through
`src/engine/edit/grammar.ts`), **11.1** (the genome role) and **4.1** (Video DNA). The stage handler is
`src/engine/jobs/handlers/analyze-reference.ts`. Status and the owner's live steps are in `STATUS.md`.

## Files

- `reference.ts`: `analyzeReference(run, ports)`, the stage's pipeline and its ports (`ReferencePorts`, `ReferenceSource`,
  `GrammarReadings`). Pure orchestration over the ports: the media functions, the speech-to-text wrapper, `runRole` for the
  segmenter and genome, and the source store.
- `beats.ts`: the beat grid and sound measures (onsets, sound hits, tempo, music, sound effects, silence before the payoff).
  Pure, over the 10 ms envelope and the speech spans.
- `measure.ts`: the per-segment motion, brightness and loudness, and the loudness per tenth. Pure.
- `copy.ts`: the copy rule. A label or layer that repeats three transcript words in order is copied content.
- `angle-bible.ts`: the Angle Bible entries the genome names genes by (read from `src/lib/meridian/study/bible.ts`).
- `config.ts`: the analysis constants (Bible values and initial values). Move to `engine/config` (see STATUS.md).
- `test/harness.ts`: the recorded ports used by the tests (test code only).
- `test/fixtures/`: the captured measurements and the recorded answers (see its README).

## Rules this folder keeps

- Every network call goes through a port, and every paid call through `runRole` or `transcribeMetered`. Nothing here calls
  `fetch` or reads `process.env`.
- A measure with no data is null, and a null field fails its check. Nothing is stored with a guessed value.
- The example's words enter the DNA only as the transcript used for segmentation. A layer or label that repeats the transcript
  is refused (the role retries once, and the gate fails if the retry does too).
- The source is released once the analysis ends, pass or fail, and the DNA's `sourceDeletedAt` is the release time.

## Tests

    NODE_ENV=development node --experimental-strip-types --test "src/engine/analyze/**/*.test.ts" "src/engine/edit/**/*.test.ts" "src/engine/claude/roles/genome.test.ts" "src/engine/claude/roles/tightener.test.ts"
