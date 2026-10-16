# Fixtures for the analyze stage

These are test inputs. No test here calls a live API. Each file says whether it is captured or synthetic.

- `reference-measurements.json` (**captured**): the output of the real `probe`, `cuts` and `timeline` functions (ffmpeg 6.1.1,
  this machine) on a generated reel. The reel is 6.0 s, four solid 320x568 colour shots of 1.5 s (red, blue, green, yellow),
  and a 1 kHz click of 60 ms every 500 ms on the sound track (120 BPM). The file's `recipe` field records it. To regenerate:
  make the reel with the same ffmpeg filters (`color` sources joined with `concat`, and `aevalsrc` for the clicks), then run the
  three functions on its bytes.
- `openrouter-segmenter.json` (**synthetic**): a chat completion in the OpenRouter shape whose content is a segmenter answer for
  the reel's four shots. Its word ids are the transcript's ids (`w0001` to `w0008`, the speech-to-text ids).
- `openrouter-genome.json` (**synthetic**): a genome answer with Angle Bible slugs and three transferable genes.
- `openrouter-genome-copies.json` (**synthetic**): a genome answer whose label repeats three transcript words. It is refused
  by the role, so the tests check the retry.
- `speech-recorded.json` (**synthetic**): a speech-to-text answer with eight words over the reel's speech, in the vendor-neutral
  shape of `media/stt.ts`.
- `readings.json` (**synthetic**): caption, zoom and loop readings in the shape the readers return. The default readings of the
  harness (the jobs tests use it). The analysis readings of the tests are built from `picture-captured.json` and the two frame_reader
  answers below.
- `picture-captured.json` (**captured**): the `/picture` answers of the punch and loop clips (see `media/STATUS.md`).
- `openrouter-frame-reader.json` (**synthetic**): a frame_reader answer in the OpenRouter chat shape, one reading for each of the 15
  frames the reel's plan gives (the frame plan of `media/frames.ts` at 6000 ms with the measured cuts). Every frame has a caption of
  two or three words in the lower band, outlined, with one word highlighted. No overlays, no text, no shake, no speed ramp. The reel
  is four flat colour shots, so it has no captions: the caption and motion readings are authored to the contract, not read.
- `openrouter-frame-reader-text.json` (**synthetic**): a frame_reader answer with a `text` key on its first frame. The strict contract
  refuses it, so the retry takes the next recorded answer. Tests use it to show that words cannot come back.

The shot-length labels the tests check against are the reel's cut times (1500, 3000 and 4500 ms), not the functions' output.
