# STATUS: analyze_reference (W6), `src/engine/analyze/`, `src/engine/edit/grammar.ts`, `src/engine/claude/roles/genome.ts` and `tightener.ts`

Phase E3, branch `eng-e3-analyze-voice`, cut from `code/beautiful-cori-1zfk11` (aa3bcf8). Covers Bible 6.2 (steps 1 to 7), 8.1
(the edit grammar), 11.1 (the genome and tightener roles) and 4.1 (Video DNA). The stage handler is
`src/engine/jobs/handlers/analyze-reference.ts`. See `README.md` for the file list.

## Done (fixture-tested)

- **Timeline (new media function, W4).** `functions/ffmpeg/timeline.ts`, route `POST /timeline`, and the client
  `src/engine/media/timeline.ts` (in-process and over HTTP). One call returns brightness and motion every 500 ms, momentary
  loudness every 100 ms (ebur128, BS.1770 gate reported as null), and a mono RMS envelope every 10 ms from 8 kHz PCM. Pure
  parsers are tested on the real ffmpeg 6.1.1 line format. `MediaFunctions` gained `timeline()`; both implementers
  (`http.ts`, `local.ts`) are updated. Nothing else implements the interface.
- **Recorded measurements.** `test/fixtures/reference-measurements.json` is captured by running the probe, cuts and timeline
  functions on a generated 6 s reel (four 1.5 s colour shots over a 120 BPM click track). The cuts land at 1533, 3033 and 4567
  ms, within one frame of the true 1500, 3000 and 4500 ms.
- **Beat grid and sound (`beats.ts`).** Onset strength from the envelope, sound hits above the 90th percentile with a 100 ms
  refractory, tempo from the autocorrelation (60 to 200 BPM; the shortest near-best lag, so a multiple is not reported; null
  when no tempo stands out), music (non-speech energy above -40 dBFS for over 60% of the duration, Bible 8.1), sound effects
  (hits not aligned to a word), and the silence before the payoff (over 300 ms, Bible 8.1).
- **Measures per segment (`measure.ts`).** Motion, brightness and loudness over each segment's span. A window with no sample
  takes the nearest sample. Silence reads as the -70 LUFS gate. An empty series is null, so the check fails.
- **The edit grammar (`src/engine/edit/grammar.ts`, Bible 8.1).** Pure. Computes hookFirstCutMs, hookPayoffMs, shot-length
  quartiles and tenths, rehookIntervalMs, motion, transitions, sound (music, bpm when found, energy per tenth, sfx per 10 s,
  silence before payoff) and endsOnLoop from what is measured. Any field whose measurement is missing is listed in `unknown`,
  and no grammar is returned (the contract has no null). See the blockers.
- **Genome and tightener roles.** `claude/roles/genome.ts` (Sonnet, `llm.analysis`, `genome@1`) and
  `claude/roles/tightener.ts` (Haiku, `llm.check`, `tightener@1`), run through `runRole`. Prompts are in
  `src/engine/prompts/genome@1.md` and `tightener@1.md` (same four parts as `segmenter@1.md`; their hashes are pinned in the
  role tests). A genome value must be an Angle Bible slug (a closed list passed in the input). A label may not repeat three
  transcript words in a row (`analyze/copy.ts`). The tightener must keep every number and emphasis word and stay within the
  word target.
- **The stage (Bible 6.2).** `analyzeReference` (`analyze/reference.ts`) runs the steps in order: resolve the reference, probe,
  timeline, cuts, frames at cuts plus two per second (cap 60, longSide 768), speech-to-text through `transcribeMetered`
  (metered, keyed, reconciled), the segmenter, the measured fields, the genome, the grammar, then release the source and build
  the DNA with `sourceDeletedAt`. The handler (`jobs/handlers/analyze-reference.ts`) reads only the production_request artifact
  and writes `video_dna` (parented on the request) only when the dna gate passes.
- **Source copy rule.** The DNA stores the transcript (as the transcript used for segmentation), the segments' structure, the
  measures and the grammar. The segmenter's `onScreenText` is dropped (see decisions). Layer descriptions and labels are
  copy-checked. A test checks that no three-word run of the transcript appears in any other stored field.
- **NOT_CONNECTED.** The stage stops before any spend when speech-to-text is not connected (`media/stt-connection.ts`), when the
  reference source is not connected, and when a port is missing. The handler throws a config error whose message starts with
  `NOT_CONNECTED:`.

## Tests

Run from the repo root:

    NODE_ENV=development node --experimental-strip-types --test "src/engine/analyze/**/*.test.ts" "src/engine/edit/**/*.test.ts" "src/engine/claude/**/*.test.ts" "src/engine/jobs/handlers/analyze-reference.test.ts"

- `beats.test.ts`, `measure.test.ts`, `copy.test.ts`: the pure functions, on synthetic envelopes with hand-known tempo and hits.
- `src/engine/edit/grammar.test.ts`: the grammar against hand labels (shots of 1500 ms, the rehook interval from known
  interrupts, the transitions of a known flash, whip and zoom).
- `reference.test.ts`: the whole stage on the captured measurements and the recorded role answers. Checks the gate, the DNA,
  the first cut within two frames, the median shot within 10%, the genome, the release, the ledger, the retry of a copying
  genome answer, the copy rule, no audio, and a missing duration.
- `claude/roles/genome.test.ts`, `tightener.test.ts`: the answer contracts, the untrusted blocks, and the pinned prompt hashes.
- `jobs/handlers/analyze-reference.test.ts`: on PGlite: the artifact is written and parented, a failing gate writes nothing,
  NOT_CONNECTED writes nothing and spends nothing, and a missing reservation is refused.
- `media/timeline.test.ts`, `media/stt-connection.test.ts`, `media/http-handler.test.ts`: the parsers, the client's order checks,
  the real timeline on a generated reel (ffmpeg present here), the route, and the connection check.

Results on this branch are in the report to the lead.

## Live steps: owner (agents hold no keys)

1. **Speech-to-text vendor (Bible 20.2).** Choose it. Write one adapter in `src/engine/media/`, put its price per minute in
   `config/prices.ts` (`stt_vendor`, null today), and set the `stt` route. Then record one transcription of a 30 s reference
   with music under the speech: word timings, the bill, and a repeat with the same key that is not billed.
2. **Deploy and record the functions.** Deploy `functions/ffmpeg` (see `functions/ffmpeg/STATUS.md`) with `/timeline`. Run the
   timeline, cuts, probe and frames on the reference through `httpMediaFunctions` and record the answers as `captured`.
3. **Captions, zoom and loop readers.** The grammar needs them (see blockers 2 to 4). Until they exist the stage fails its gate
   on purpose.
4. **Reference source.** Wire the `ReferenceSource` port (resolve and release) once the owner decides where reference media is
   held (S3 is retired; Drive or Postgres, NORTH_STAR decision 2).
5. **Live analyze run (Bible 19 E3).** One reference reel, with the real segmenter and genome calls (Sonnet). Attach the
   artifact ids, the ledger lines per role, the timeline and STT numbers, and the grammar against the reference's hand labels
   (within 15% on shot length and caption size, once captions are measured).

## Blockers and decisions for the lead

1. **Speech-to-text vendor (Bible 20.2): owner decision.** Blocks analyze and voice. Both stop with NOT_CONNECTED before any spend.
2. **Captions (OCR) are not measured.** Bible 6.2 step 6 and 8.1 name OCR of the frames. OCR is not in the Bible's media list,
   `MediaFunctions` has no OCR, and no vendor is chosen. The contract's `captions` block has no null, so the DNA cannot be
   stored without it. Decision needed: an API for OCR through the gateway (an owner vendor choice, Bible 20.2), or a vision read
   by a role. Local OCR would break principle 8.
3. **Zoom jumps and shake are not measured.** `motion.punchIn*`, `rehookIntervalMs` and the zoom class of `transitions` need zoom
   detection. No function exists. Method to decide (ffmpeg feature tracking, or a vision read).
4. **endsOnLoop is not measured.** It needs the first and last frame compared (Bible 8.1). The frame plan does not request
   those two frames yet. It is a small addition in W4 once the lead agrees the extra two frames are allowed past the cap of 60.
5. **Reference source store.** `ReferenceSource` is a port with no production implementation. `ig:reel/<id>` needs a source
   URL, and `s3://` is retired. Until the store is decided, the stage refuses with NOT_CONNECTED.
6. **Angle Bible slugs.** The Bible and the contracts name the Angle Bible but do not list its values. The only list is
   `src/lib/meridian/study/bible.ts` (11 dimensions, 17 entries). `analyze/angle-bible.ts` reads it and passes the entries to
   the genome role as input, so the Claude folder stays free of study code (its boundary test). Lead: confirm the engine may
   read that module, or name the vocabulary another way.
7. **Speech route (TTS) model is null** in `config/routes.ts` (`tts`). The voice stage refuses with NOT_CONNECTED from the
   router. The model id is an eng-contracts change.
8. **Config placement.** `analyze/config.ts` and `voice/config.ts` hold initial values that should move to `engine/config`
   (eng-contracts). Each value is named in its file.

## Decisions taken in this build (lead to confirm)

- **onScreenText is not stored.** The segmenter reads visible text into `onScreenText` (its prompt rule 6). Bible 1 says no
  source words enter any field except measurements and the transcript used for segmentation. The field is dropped from the
  stored DNA; the layers and labels are copy-checked instead. Reverse this if the lead wants visible text in the DNA.
- **Reference language.** Speech-to-text is asked for the script's language (`request.script.language`), because the format has
  no language field. A reference in another language fails the transcript check.
- **Frames.** The frame plan is Bible 6.2's (cuts first, two per second, cap 60). The Bible's "retry with denser frames" is not
  built: the cap is already reached, so a reference with fewer than three segments fails the gate (escalation).
- **Source release before the DNA is written.** The release runs before the DNA row, so `sourceDeletedAt` is accurate. If the
  DNA write then fails, the source is gone; a retry must re-resolve the reference. The reference store must keep it until the
  stage has passed.
- **Failed gates still release the source.** A failing analysis does not keep a copy of the reference.
- **The genome role reads the transcript as data** (its own words may judge the hook), but it can only return slugs and labels
  that do not repeat it.
- **Unmeasured silence.** A silent segment's loudness is the -70 LUFS gate, which is a measurement of silence, not a guess.
- **Tempo.** A tempo is stored only when it stands out (ratio 1.5). Otherwise `sound.bpm` is omitted, as the contract allows.

## Interpretations

- The grammar's hookFirstCutMs is the duration when there is no cut (one shot), and rehookIntervalMs uses the gaps between the
  measured interrupts, with the video's start and end as boundaries.
- A zoom reading with no jumps gives punchInScale 1 (no scale change). That is a defined value, not a guess.
- Transitions: zoom (a zoom jump within 250 ms of the cut) before flash (brightness step of 0.3 across the cut) before whip (a
  motion sample of 0.25 or more at the cut) before hard.

## Owner live run

None. No provider is called in any test. The recorded answers are hand-written to the OpenRouter shape and the role
contracts; the measurements are captured from ffmpeg 6.1.1 on a generated reel. The transcript, captions, zoom and loop
readings are synthetic and labelled so in their fixtures.

## Files outside this folder (granted by the lead, or to be merged by their owners)

- `src/engine/edit/grammar.ts` and `grammar.test.ts` (the W6 file of `edit/`). The rest of `edit/` belongs to eng-edit-compose.
  No `edit/STATUS.md` was written, so the owner of that folder keeps its status file.
- `src/engine/claude/roles/genome.ts`, `tightener.ts` and their tests (granted). `ClaudeRole` already lists both roles, so
  `contracts/ledger.ts` is unchanged. `claude/boundaries.test.ts` forbids any `lib/meridian` import in that folder, which is why
  the Angle Bible entries come in through the input. eng-pipeline's `claude/STATUS.md` is not edited: the roles are described here.
- `src/engine/prompts/genome@1.md` and `tightener@1.md` (granted). `prompts/STATUS.md` is not edited.
- `src/engine/jobs/handlers/analyze-reference.ts` and `voice.ts` with their tests (granted). `jobs/handlers/STATUS.md` is not
  edited. The ports the worker must wire are listed in `voice/STATUS.md` and below.

Ports the worker must wire for these two handlers (none is wired in this branch): `ReferenceSource` (resolve and release),
`speech` (from `speechToTextConnection`), `sttPricePerMinuteUsd`, `roles` (the Claude client's dependencies), the media functions,
the asset router, `loadAudio`, the voice kit store (`voiceKit`), and the claims store (`claims`, optional).
