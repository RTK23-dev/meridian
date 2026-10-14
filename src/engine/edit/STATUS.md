# STATUS: edit (W8), Phase E3

Branch `eng-e3-editor`, cut from `origin/code/beautiful-cori-1zfk11` (aa3bcf8). Covers `src/engine/edit/` (except `grammar.ts`,
which is W6's and is not on this branch) and `src/engine/jobs/handlers/edit.ts` with its test. Details: `README.md` here.

## Done

- `buildEdl(input)` (editor.ts): the Bible 8.2 steps. Clock and outro hold; shots placed in their beats (several shots in a beat
  share its span in plan order); cuts snapped to word gaps, word edges, beats (with music) or frames, never inside a word and never
  past what a take can show; short shots merged into a same-type neighbour; the hook cut placed at the scaled time; long shots split
  with a punch-in at each cut; transitions sampled from the grammar's mix by the seed; punch-ins on emphasis words and at re-hook
  points; captions grouped by a cost DP into the grammar's size range, breaking on punctuation and beats, and moved to the lower band
  over a presenter; the loop; the voice set to -14 LUFS from its measured level; music ducked by 18 dB; the seed from the request id.
- Every 8.3 rule as a named pure function in `rules.ts` (`cutsOutsideWords`, `shotLengthBounds`, `captionLengthInRange`,
  `captionWordsMatchVoice`, `captionTiming`, `captionsInSafeZone`, `captionsOffPresenterFace`, `voiceReachesMasterLoudness`,
  `voiceGainDrawable`, `musicDuckedUnderSpeech`, `durationMatchesClock`, `noBlackGaps`, `sameShotTypeRun`, `hookCaptionByMs`,
  `hookMotionWithinMs`, `sourcesCoverClips`, `layoutWithinTimeline`, `drawableByCompiler`, `truePeakWithinLimit`), plus
  `edlMatchesContract`. `checkEdl(edl, ctx)` runs them all, stops at the contract, and names each failing shot once. A rule that is
  missing an input it needs fails and says which input (unknown means fail).
- Thresholds from `config/thresholds.ts` (`thresholds.edit`, `thresholds.postRender`); the 8.2 constants are in `tuning.ts`.
- The handler (`jobs/handlers/edit.ts`): `createEditHandler({ loadStyleKit, loadMusic? })`. Pass: writes the `edl` artifact with every
  input as its parent, and names it `edl:<edlId>`. Fail: writes nothing, and the gate names the checks and shots. Missing or
  foreign inputs are refused as `invalid_input`, not as a gate result.
- The E1 chain (`contracts/fixtures`) builds an EDL that passes every check: 24 s, hook cut at 857 ms (the word edge nearest the
  scaled 943 ms), all 41 voice words captioned, the voice gain +1.2 dB. The EDL compiles with the existing compiler, twice, with the
  same composition hash. The E1 hand-written EDL also compiles.

## Tests run in this worktree

- `NODE_ENV=development node --experimental-strip-types --test` on the six edit test files: **78 pass, 0 fail, 0 skipped**
  (`edit/prng` 3, `edit/words` 15, `edit/geometry` 5, `edit/rules` 19, `edit/editor` 30, `jobs/handlers/edit` 8; the handler tests run on
  PGlite).
- Engine boundary scans (`media`, `review`, `gateway`, `claude` boundaries): **21 pass, 0 fail**. No production file here reads the
  environment, calls fetch, or imports a test helper outside its folder.
- `npm run typecheck`: exit 0. `npm run lint`: exit 0, 0 errors, 4 warnings, all in existing `src/components/` files.
- The full `npm test` was not run here, as the lead asked.

## Decisions and gaps (for the lead)

1. **Orchestrator and registry (W2): the edit stage must receive `validated_request`.** `registry.ts` gives `edit` the reads
   `scene_plan, take, voice_track, video_dna`, and `orchestrator.ts` `nodeSlots.edit` passes `plan, dna, voice` and the takes. The
   handler needs the validated request for the style kit reference and the emphasis marks. Until W2 adds it, a live edit refuses with
   `invalid_input`. This is a W2 change, which this workstream may not make.
2. **Style kit and music ports are not wired.** `loadStyleKit` is required. No kit reader exists yet, so the worker must supply it.
   `loadMusic` is optional, and no music source exists in the inputs, so the EDL has no music until one is wired.
3. **Tuning constants belong in `config/`.** `edit/tuning.ts` holds the 8.2 numbers (snap windows, fit shares, hook times,
   punch-in amplitudes, music gain, caption maximums, drawable transitions and effects, the caption geometry). The lead should move
   them into `config/thresholds.ts` (W1), with `edit/geometry.test.ts` kept as the drift check against the template.
4. **Take length versus the take gate.** The take gate allows a take to be 10% shorter than its shot. The edit gate requires its
   source to cover its clip, so a take 10% short passes the take gate and fails the edit gate, and goes back to produce_shot. The
   gates disagree by design; the lead should decide whether the take gate's tolerance should be zero on the short side.
5. **Editor decisions have nowhere to go (L7).** The notes (merges, splits, the hook placement, dropped transitions) are not written
   to the manifest, because `Decision.by` has no `editor` value. This needs a contract change (W1, lead approval).
6. **Things the grammar or compiler cannot carry, reported not invented:** J and L cuts (8.1 does not measure them, so every cut is
   hard or a sampled transition); sound effects (no source, `sfxPer10s` recorded as unplaced); speed ramps (the compiler refuses
   `speed_ramp`); silence before the payoff (a voice-stage pacing mark, not an edit); the shake effect (needs an impact sound).
7. **True peak is not checked here.** The voice track carries LUFS only. `truePeakWithinLimit` is exported for the post-render review,
   which has the measured peak. A missing peak fails there.
8. **Product beats need real imagery (L8).** The editor passes `product.card` props through unchanged and never adds `heroUri`. The
   pre-render gate should refuse a product beat without imagery; the product kit is not loaded here.
9. **Full-frame components are not checked for safe zones here.** A component without a box is full frame, and its text layout is
   checked by the compose tests. Only the captions band and graphics boxes are checked against the zones.
10. **Repair pass.** 8.2 says a violation is fixed by re-running the step, then validated once. The steps that fix length, cut
    placement and caption grouping run inside the build, and validation runs once after. A second pass would reproduce the same
    deterministic result, so it is not run. The fixable cases are fixed by the build; the rest fail the gate with the named shots.
11. **Failing EDLs are not stored.** A failed build writes no `edl` artifact, per the stage rule. The gate result carries the detail.

## Owner's live run (E3 acceptance, Bible 19)

Agents hold no keys. The owner runs the E3 acceptance after W2 wires the reads above and the kit and music ports:

1. One reference reel, one script and one page's kits, run through analyze, voice, plan, produce and check, then edit to a delivered
   master with no human step.
2. Record: the edit's gate result (the checks and shots), the `edl` artifact id, the `edl:<id>` slot, and the EDL's content hash.
3. Compare the output grammar with the reference: shot length (p50 of the clips) and caption size, each within 15% of the reference.
4. Check a budget that covers only the fixed per-master cost yields an all-code plan, and that it still delivers.
5. Record any note from the build that is a gap for the owner (items 5 and 6 above) on the phase PR.
