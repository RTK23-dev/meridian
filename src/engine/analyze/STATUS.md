# STATUS: analyze_reference (W6), `src/engine/analyze/`, `src/engine/edit/grammar.ts`, `src/engine/claude/roles/genome.ts` and `tightener.ts`

## W2 wiring pass (branch `eng-e45-leftovers-2`)

Not run in this pass. `jobs/runtime.ts` `analysisPortsOf(analysis, picture)` wires `analysisReadings({ picture, roles })` into
`analyze_reference` when the composition gives a `picture` client and no readings of its own (the wiring the Wiring section above asked
for). `renderReadings.ts` is used by `post_render_review` through `readRenderedFrames` and `overlayMeasures`. Production passes no
`analysis` composition yet, so the stage stays not_implemented in production (fail closed). Tests: `jobs/runtime-wiring.test.ts`.

Phase E3, branch `eng-e3-analyze-voice`, cut from `code/beautiful-cori-1zfk11` (aa3bcf8). Covers Bible 6.2 (steps 1 to 7), 8.1
(the edit grammar), 11.1 (the genome and tightener roles) and 4.1 (Video DNA). The stage handler is
`src/engine/jobs/handlers/analyze-reference.ts`. See `README.md` for the file list.

**Follow-up, branch `eng-e3-vision-measure` (from `origin/code/beautiful-cori-1zfk11`, 79f7a92).** Zoom jumps and the loop are
now measured (see "Zoom and loop" below). Captions are NOT measured: the `frame_reader` role needs a `ClaudeRole` value that
`contracts/ledger.ts` does not have. Per the lead's instruction, no contract was edited and no role or prompt was written. The
captions reading stays null, so the grammar's `captions` field stays unknown and the DNA gate fails on purpose.

**Follow-up, branch `eng-detectors` (from `origin/code/beautiful-cori-1zfk11`, d5a62c1): frame_reader.** The captions, shake and
speed ramps are now read by the `frame_reader` role (contracts@4), so the grammar's `captions` and `motion` fields are filled on
honest inputs, or unknown with their reason. Blockers 2 and 3 below are answered by this follow-up, with the decisions it needs.

## frame_reader (eng-detectors)

- `claude/roles/frame_reader.ts` (+ `frame_reader.test.ts`) and `prompts/frame_reader@1.md`. Haiku with vision, `llm.check`, stage
  `analyze_reference`. Input: the duration, the cut list and up to 24 frames (768 px). Answer: one reading per frame, in order, with
  `index`, `confidence`, up to 3 caption boxes (box, `words` 1 to 12, `style` class, `highlight` one_word / none / unclear), up to 4
  overlay boxes (box, `kind`), `textWords` (a count), `shake` and `speedRamp` (none / present / unclear). The answer is strict and has
  no string field except fixed enums; a test walks its JSON schema to prove it. No text can come back, so none reaches the DNA.
  Estimate 12k in and 2k out, $0.022 at Haiku's $1 / $5 rate (Bible 11.1 lists 12k / 1k; the output is raised, see decisions).
- `analyze/frameReader.ts`: `readFrames` (one `runRole` call; a refused answer is `refused`, a duplicate with no stored answer is a
  conflict, a twice-invalid answer throws `RoleAnswerError`), `selectFrames` (evenly spaced, first and last kept, when there are
  more than 24), `captionsOf`, `judgementOf` and `summariseFrameReadings` (pure aggregation), and `analysisReadings({ picture, roles })`,
  the production readings port. It combines the picture measures (zoom jumps and loop, `readings.ts`) with the frame_reader readings
  (captions, shake, speed ramps).
- Grammar: `captions` comes from the readings; `motion.shakeOnImpact` and `motion.speedRamps` from the judgements. A field with too few
  confident frames is null with its reason, and `edit/grammar.ts` puts that reason in its unknown note (`reasons`). The grammar no
  longer says "OCR".
- `ReadingsScope` carries `requestId`, `reservationId` and `attempt` (the role call's ledger key). `GrammarReadings.reasons` is optional.
- `analyze/renderReadings.ts` (post-render, Bible 6.12 and 12.3): `readRenderedFrames` (the same call on the frames the review sends),
  `overlayMeasures` (one `present` per graphics clip: an overlay whose box overlaps the EDL box by `overlayMinIou`, or any overlay
  when the clip has no box), `captionWordsAt` and `textWordsAt` (counts). A frame not read, or read with too little confidence, is
  null. No text of the screen is read.
- Thresholds (`analyze/config.ts`, `frameReader`, all initial): `minConfidence` 0.5, `minCaptionFrames` 3, `minJudgedShare` 0.5,
  `shakeShareMin` 0.25, `speedRampShareMin` 0.1, the caption band at thirds, `overlayMinIou` 0.2.
- Fixtures: `test/fixtures/openrouter-frame-reader.json` (synthetic: the 15 frames of the reel's plan, with captions on every frame,
  two or three words, lower band, one word highlighted, and no shake or speed ramp) and `openrouter-frame-reader-text.json` (words in
  a text key: refused, then retried). Synthetic because the reel is four flat colour shots.

## Decisions for the lead (frame_reader)

1. **Highlight is read per frame.** Bible 8.1 measures the highlight as a colour change between frames 100 ms apart. Sampling is
   2 frames per second, so frames 100 ms apart are not available. The reader says whether one word of a caption is set apart in that
   frame. That is a single-frame proxy, and the gold labels should check it.
2. **Shake and speed ramps are judgements on sampled stills, not measurements.** shakeOnImpact here means "shake in the sampled
   frames". It is not tied to the impacts (the sound hits), because the frames are not placed on them. Speed ramps across half-second
   samples are weak evidence. The owner's labels decide whether to trust them. The alternative is a code measure: a translation series
   at 10 to 25 fps from a small grey copy (not built, not in the contracts). Lead: choose, or drop the two fields (contracts).
3. **Output tokens: 2k, not the 1k of Bible 11.1.** 24 frames with a caption and an overlay each run past 1k of JSON. Bible 11.1 needs
   the new row value (eng-contracts, owner confirm).
4. **Frame cap 24.** A reference has up to 60 frames. The reader gets an even spread of 24 for captions and motion (the reel has 15).
5. **Post-render: counts and presence only.** `OcrMeasurement.onScreenText` in `review/gates/postRender.ts` needs words, and the
   frame_reader never returns them. So `forbidden_terms_absent` cannot be evaluated from frame_reader, and stays not evaluated (fail
   closed). `captionWordsAt` gives counts, so `captions_ocr_match_script` can check counts but not the identity of the words. The lead
   decides: count-only check, or no text check until a text source exists.
6. **Thresholds sit in `analyze/config.ts` and `media/config.ts`.** They should move to `engine/config` (eng-contracts), with
   the other initial values listed in blocker 8.

## Wiring (not edited here: jobs and review are not this branch's folders)

- `jobs/handlers/analyze-reference.ts` (the worker's ports): pass `readings: analysisReadings({ picture: <the picture client>,
  roles: <the Claude client's deps> })` in place of `pictureReadings(...)` alone. The handler's test keeps the default readings and
  is unchanged.
- The render review (`jobs/handlers/post-render-review.ts`, `review/gates/postRender.ts`): `blackFrames` from
  `blackFrameMeasures(await media.blackFrames(...), requiredFrameTimes(edl))`; `silence` from `await media.silence(...)` (its
  `longestMs`); `overlays` from `overlayMeasures(graphicsClips, readings)` with `readings` from `readRenderedFrames` on the frames
  at each graphics clip's midpoint, requested at `thresholds.claude.visionMaxLongSidePx` (chunked to 24 frames); `ocr` stays
  `undefined` until decision 5. The review's port types take `Pick<MediaDetectors, ...>`.
- The take check (`jobs/handlers/check-take.ts`, `review/takeCheck.ts`): `takeCodeMeasures({ black, flicker, motion })` gives the
  `measurements` that `review/take/code.ts` `codeRows` reads (its three fields match by name). The port is
  `Pick<MediaDetectors, "blackFrames" | "flicker" | "motion">`.

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
- **Zoom and loop (follow-up).** A new media function, `POST /picture` (`functions/ffmpeg/picture.ts`), with the client
  `src/engine/media/picture.ts`. It decodes a 64 px grayscale thumbnail every 100 ms, and the true last frame from the end of the
  stream. Per pair of neighbours it fits a scale and a shift (the later thumbnail is the earlier one magnified about the centre
  and moved), and reports the scale and a fit ratio. A pair that straddles a scene cut is not measured. It also reports the luma
  distance of the first frame and the last. `analyze/zoom.ts` (pure) turns the pairs into zoom jumps (|scale - 1| above 8%, fit at
  most 0.6, consecutive same-direction pairs joined) and the loop (distance at most 0.04). `analyze/readings.ts` is the stage's
  `readings` port built from that client. `MediaFunctions` is unchanged: the picture client is on `HttpMediaFunctions` only, so the
  three fixtures that implement `MediaFunctions` need no change.
- **Grammar motion (follow-up).** `MeasuredZoom.shake` and `speedRamps` are `boolean | null`. The motion fields stay unknown while
  either is null. rehookIntervalMs and the transitions need only the jumps, so they are computed from the zoom reading. Punch-ins
  are the zoom-ins only (scale above 1); a zoom-out counts as a jump, not as a punch-in.

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
- Follow-up: `analyze/zoom.test.ts` (pure: jumps, joins, cuts, the 8% line, the loop threshold), `analyze/readings.test.ts`
  (the readings port on the recorded answers in `test/fixtures/picture-captured.json`), `media/picture.test.ts` (the scale
  model on exact synthetic pictures, the contract, the client, the route, and the generated clips when ffmpeg is present),
  `edit/grammar.test.ts` (zoom-ins only, and shake or speed ramps null keeps the motion unknown), and `reference.test.ts` (the
  stage with the picture readings: the gate fails naming only captions and motion).

Results on this branch are in the report to the lead.

## Live steps: owner (agents hold no keys)

1. **Speech-to-text vendor (Bible 20.2).** Choose it. Write one adapter in `src/engine/media/`, put its price per minute in
   `config/prices.ts` (`stt_vendor`, null today), and set the `stt` route. Then record one transcription of a 30 s reference
   with music under the speech: word timings, the bill, and a repeat with the same key that is not billed.
2. **Deploy and record the functions.** Deploy `functions/ffmpeg` (see `functions/ffmpeg/STATUS.md`) with `/timeline`. Run the
   timeline, cuts, probe and frames on the reference through `httpMediaFunctions` and record the answers as `captured`.
3. **Captions reader and motion readers.** The grammar needs captions (blocker 2), and shake and speed ramps (blocker 3). The
   zoom and loop readings are measured by `POST /picture`, so the owner's live step is to deploy it with `/picture` and record one
   reference's answer as `captured`. Until captions and motion exist the stage fails its gate on purpose.
4. **Reference source.** Wire the `ReferenceSource` port (resolve and release) once the owner decides where reference media is
   held (S3 is retired; Drive or Postgres, NORTH_STAR decision 2).
5. **Live analyze run (Bible 19 E3).** One reference reel, with the real segmenter and genome calls (Sonnet). Attach the
   artifact ids, the ledger lines per role, the timeline and STT numbers, and the grammar against the reference's hand labels
   (within 15% on shot length and caption size, once captions are measured).
6. **frame_reader live run (eng-detectors).** One reference with 15 to 24 sampled frames through `analysisReadings` on the Haiku route
   (`llm.check`, `verified: false`). Record the answer, its model and generation id, the usage cost against the ledger estimate, and
   whether the answer parsed with no retry. Then compare the captions (words per caption, band, highlight), the shake and the speed
   ramps with the owner's hand labels on the same frames. Label 100 shake and 100 speed-ramp examples before either flag may gate.
   For the render review: one rendered video, the overlay and caption-count readings against its EDL.

## Blockers and decisions for the lead

1. **Speech-to-text vendor (Bible 20.2): owner decision.** Blocks analyze and voice. Both stop with NOT_CONNECTED before any spend.
2. **Captions: answered by `frame_reader` (eng-detectors).** `frame_reader` is in `CLAUDE_ROLES` (contracts@4). The role and its
   aggregation are built (see "frame_reader" above). Open: the jobs wiring (`analysisReadings`), and the owner's live run that checks
   the captions against hand labels. The highlight is a single-frame proxy (decision 1 above).
3. **Shake and speed ramps: answered by `frame_reader` as judgements on sampled stills (eng-detectors).** Decision 2 above: the
   readings are not on impacts, and a code measure at 10 to 25 fps is the alternative. Lead to choose, or drop the two fields
   (contracts). Until then the flags come from the judgements, with their reasons when they are null.
4. **endsOnLoop: measured, one open point.** The loop reading is the first frame against the true last frame of the picture
   (`/picture`), not two extra frames in the Bible 6.2 frame plan, so the cap of 60 is unchanged. Open: the threshold 0.04 is
   initial, measured on generated clips only (a still with its brightness returning gives 0.022, a zoom drift gives 0.24).
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
- Follow-up (granted by the lead): `functions/ffmpeg/picture.ts` and its wire, type, http and limit entries; `src/engine/media/`
  (`picture.ts`, its test, `test/picture-clips.ts`, `http.ts`, `index.ts`, `config.ts`, and the handler list in
  `boundaries.test.ts`). `edit/grammar.ts` and its test. `analyze/test/harness.ts` and `reference.test.ts`. No contract, no
  `claude/` file and no prompt is changed. `media/STATUS.md` and `functions/ffmpeg/STATUS.md` describe the picture route.

- Follow-up (eng-detectors, granted by the lead): `claude/roles/frame_reader.ts` and its test, `prompts/frame_reader@1.md`,
  `edit/grammar.ts` (the `reasons` input and the note wording, no change to the fields). The detectors are in `src/engine/media/`
  and `functions/ffmpeg/` (see `media/STATUS.md`). `claude/roles/STATUS.md` and `prompts/STATUS.md` each carry one short note
  for frame_reader. `edit/` has no STATUS file of its own; the grammar change is described here.

Ports the worker must wire for these two handlers (none is wired in this branch): `ReferenceSource` (resolve and release),
`speech` (from `speechToTextConnection`), `sttPricePerMinuteUsd`, `roles` (the Claude client's dependencies), the media functions,
the asset router, `loadAudio`, the voice kit store (`voiceKit`), and the claims store (`claims`, optional).
