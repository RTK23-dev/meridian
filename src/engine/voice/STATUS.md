# STATUS: voice stage (W6), `src/engine/voice/`, and `src/engine/jobs/handlers/voice.ts`

**Brief requests (contract v8, this branch).** `VoiceRun` takes `script` (the resolved words, `script/resolve.ts`) next to `request`: the
request's maxMs and voice page are still read from the request, and the beats and language from the script. The handler reads the written
script of a brief through its inputs. Production's voice ports are per reservation (`VoicePortsFor`, `jobs/production-stages.ts`) and refuse
before any call while `SPEECH_OUTPUT_BLOCKERS` lists a reason (MP3 storage, unsettled speech billing; see `../jobs/STATUS.md`, decisions 2 and 3).

Phase E3, branch `eng-e3-analyze-voice`, cut from `code/beautiful-cori-1zfk11` (aa3bcf8). Covers Bible 6.3 (steps 1 to 5) and
the tightener of 11.1. `README.md` lists the files.

## Done (fixture-tested)

- **Text and pacing marks (`text.ts`).** Each beat is one sentence group, with a full stop when it has none. The marks record
  where each beat and each emphasis word sits. The speech route takes plain text (PROVIDER_APIS.md), so the marks are data for
  the checks and are not sent as markup. This is the one gap against "SSML-like pacing marks" in Bible 6.3.
- **Speech (through the asset router).** The stage calls `router.produce` with the `tts` model class. The page's voice kit
  provides the provider voice id (`voiceId`), and the pace goes in `ProduceInput.speechSpeed`. The speech adapter sends
  `speed` when it is not 1, and its id carries the speed, so a cache key cannot mix paces (`assets/providers/openrouterSpeech.ts`).
  The router's own answers map to the stage: a done take continues, not_connected stops, a content refusal fails the gate,
  a budget refusal and a missing duration throw.
- **Measure before transcribe.** The take's duration is probed first. A take over `maxMs` is not transcribed.
- **Faster pace, then the tightener (6.3 step 5).** Over `maxMs`: two faster paces (1.1, then 1.2). Still over: the tightener
  (Haiku, `llm.check`) shortens the longest beat once, keeping its numbers, emphasis and claims, and the narration is spoken
  again at the fastest pace. Still over: the length check fails. The tightener's target keeps the beat's share of the overrun.
- **Transcript (6.3 step 3).** The take goes through `transcribeMetered` (reserved, keyed, reconciled). The script is aligned
  to the transcript by a minimum-edit alignment. A word error rate above `thresholds.voice.wordErrorRateMax` (3%), or a script
  word the speech did not say, is a retake of the same text once. A second mismatch fails the gate.
- **Loudness and track (6.3 step 4).** Integrated loudness from the loudness function, the duration from the probe, the words
  from the transcript (the TTS timings are never used), and beat spans that start at the first aligned word of each beat and
  cover the duration with no gap (`timings.ts`). A beat with no spoken word, or a word the speech did not say, fails the gate.
- **NOT_CONNECTED.** The stage stops before any paid call when speech-to-text is not connected, when the speech route has no
  model (the router's reason), and when the voice kit store is not wired (`jobs/handlers/voice.ts`).
- **Track artifact.** `voice_track` (parented on the request) is written only when the voice gate passes, with the speech's
  content and no free text from the model.

## Tests

    NODE_ENV=development node --experimental-strip-types --test "src/engine/voice/**/*.test.ts" "src/engine/jobs/handlers/voice.test.ts" "src/engine/assets/providers/openrouterSpeech.test.ts"

- `align.test.ts`: the alignment (match, substitution, deletion, insertion, empty script).
- `text.test.ts`: the text and its marks (offsets point at the words), the per-beat word counts, and the beat spans (full
  coverage; a missing first word and an empty beat are reported, not placed).
- `voice.test.ts`: the pipeline on recorded answers, with the real router, speech adapter and tightener over recorded transports.
  Over `maxMs`: paces 1.0, 1.1, 1.2, then the tightened text at 1.2 (the tightener is called once); still over: fails the length
  gate and transcribes nothing; a word error above 3%: one retake with new audio, then passes; a second mismatch fails; not
  connected (speech-to-text) and no speech route: nothing is sent and nothing is written; an unmeasurable loudness fails.
- `jobs/handlers/voice.test.ts`: on PGlite: NOT_CONNECTED when the kit store is not wired (nothing read or spent), a kit that
  is not in the workspace stops the stage, and a missing reservation is refused.
- `openrouterSpeech.test.ts`: the speed is sent, the identity carries it, and out-of-range speeds are refused before a request.

The test takes are generated mp3 bytes whose size is their length in milliseconds, and the recorded probe reads that length.
The speech-to-text answers are synthetic and labelled so in the test. Nothing calls a live API.

## Live steps: owner (agents hold no keys)

1. **Speech-to-text vendor (Bible 20.2).** The same live step as `analyze/STATUS.md` item 1. Voice cannot run without it.
2. **Speech route model.** Set the `tts` model in `config/routes.ts` (eng-contracts; it is null today, and `eleven_v4` and the
   Gemini TTS id are unverified). Confirm that the speech route accepts `speed` (PROVIDER_APIS.md lists it; no live call has
   checked it). Record one take at 1.0, 1.1 and 1.2 for the same text: the durations, the bytes, and the bill (the list estimate
   is flagged as an estimate).
3. **Loudness reader.** The stage calls `media.loudness` on the take's bytes through the media functions. Confirm it on a live
   take and record the answer.
4. **Take storage.** The router writes takes through a `MediaStore`. Wire the store that reads them back (`loadAudio`).
5. **Live voice run (Bible 19 E3).** One script, one page's voice kit. Attach the take uri, the duration, the LUFS, the word
   error rate, the beat spans, the router's ledger entry and the speech-to-text bill.

## Blockers and decisions for the lead

1. **Speech-to-text (Bible 20.2): owner decision.** Stops the stage with NOT_CONNECTED before any spend.
2. **Speech route model is null** (`config/routes.ts`). The router reports the stage as not connected. Owner or eng-contracts.
3. **`loadAudio` (the take store) is not wired.** The voice handler's `VoicePorts.loadAudio` is a port with no production
   implementation. A take the router wrote but the stage cannot read fails with an error.
4. **Pacing marks are not sent.** The speech route takes plain text. If the owner's vendor accepts markup, the marks in
   `text.ts` are the place to add it. Until then the emphasis words are checked, not spoken differently.
5. **AssetSpec needs a shot id.** The router's spec requires `shot_` ids. The narration uses a deterministic id derived from the
   request (`narrationShotId`). A voice spec without a shot id is a contract change (eng-contracts).
6. **AssetSpec has no speed.** The pace is carried in `ProduceInput.speechSpeed` and in the adapter's identity, not in the spec.
   A speed field on AssetSpec would be the cleaner contract (eng-contracts; lead approval).
7. **The tightener's claims input** is the product kit's approved claim texts for the request. The product kit store is not
   built, so the handler passes none unless the worker wires `claims`. Its numbers are still checked through the beat text.
8. **Config placement.** `voice/config.ts` (speeds, retakes, tighten count) should move to `engine/config` (eng-contracts).

## Decisions taken in this build (lead to confirm)

- **The track's words are the transcript's words**, not the script's, because the track stores what was spoken and the beat
  spans come from the alignment. Under the 3% limit they match the script word for word, apart from substitutions.
- **After tightening, the narration is spoken at the fastest pace already tried** (1.2), so the pace does not fall back to 1.0
  for the tightened text.
- **A retake is new audio** (a new `seed`, so a new call and a new speech-to-text key). The speech-to-text key is the audio's
  hash, so the same bytes would be refused as a repeat. Two calls on the same audio are one bill.
- **The narration is measured before it is transcribed.** Bible 6.3 lists the transcription (step 3) before the length (step 4
  and 5). This build checks the length first, so an over-length take costs a speech call and a probe, not a paid transcription.
  The result is the same: only a take within `maxMs` is transcribed and gets a track.
- **The spec's duration is `maxMs`** (TTS takes no duration), so the cache key is stable across attempts.

## Owner live run

None (see the steps above). No provider is called in any test.
