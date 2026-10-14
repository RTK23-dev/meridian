# STATUS: engine compose (W9): compiler, style kit, five components, golden frames

Phase E1, wave B. Branch `engine/e1-w9-w10`, cut from `code/beautiful-cori-1zfk11` (7fd32ae). Covers `src/engine/compose/`
(and the `components/`, `golden/` and `snapshots/` folders inside it). Details: `README.md` in this folder.

## Done

- `compile(edl, styleKit, components)` → `{ files, composition, assets }`. Pure. Byte-identical on repeat. The
  composition's `contentHash` (over the file hashes) is the render idempotency key. Validates the EDL, the kit and every
  component's props at the boundary. Refuses what it cannot draw exactly (overlaps, unknown components or transitions,
  `speed_ramp`, bad gains, unsafe font names). Escapes every text value.
- `styleKit.ts`: kit → `:root` custom properties (`--kit-*`), fixed order, plain font names only.
- Five components in `components/<name>/`: `captions.karaoke`, `title.hook`, `kinetic.punchline`, `product.card`,
  `cta.card`. Each has `component.html`, `props.ts` (zod), `fixtures/` (3 prop sets), `index.ts`, and golden PNGs
  (15 frames in total, in `components/<name>/golden/`).
- Probes confirmed the template contract used here: two instances of one template with different values render
  correctly, arrays pass through `data-variable-values`, and a host's EDL `box` places a component's content.
- Contract tests for every component: schemas, fixtures, declared variables, forbidden APIs, kit colours only, safe-zone
  geometry for the text components.
- `hyperframes lint` is run on the compiled EDL fixture and on each of the 15 component fixtures: 0 errors, 0 warnings.
- Snapshot of the compiled EDL fixture (`snapshots/edl-fixture/`).
- `npm run engine:golden` (added to package.json): renders each fixture locally, compares frames with the stored PNGs
  (pass under 1% of pixels). Not run by `npm test`.

## Tests run in this worktree

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/compose/**/*.test.ts' 'src/engine/render/**/*.test.ts'`:
  **109 pass, 0 fail, 0 skipped.** The lint tests ran (not skipped): the HyperFrames CLI works here.
- `npm run engine:golden` (with `HYPERFRAMES_BROWSER_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`):
  **15 pass, 0 fail**, run twice (once to write PNGs, once to compare). Chrome headless shell 141.0.7390.37, ffmpeg 6.1.1.
- A scratch render (not committed): the contracts EDL fixture compiled with synthetic media (colour video, sine audio)
  rendered locally: 1080 × 1920, 30 fps, 720 frames, duration 24.000 s, AAC stereo. Frames at 1, 5, 12, 16 and 22 s
  show the expected clips and components.
- `npm run typecheck`: exit 0. `npm run lint`: exit 0, 0 errors, 4 warnings, all in existing `src/components/` files.
- Full `npm test` on the final state: exit 0. `scripts/` 146 pass; `src/` 2544 pass, 0 fail, 41 skipped (existing
  database-gated tests). The `env-example` test caught an env read in `golden.run.ts`; that read moved to `golden.update.ts`.

## Owner's live run (E1 acceptance, Bible 19)

Agents hold no keys. The owner runs:

1. Wire the cloud adapter with the real transport, a HeyGen key from Meridian's credential resolver, `resolveAsset`
   (storage), `storeVideo`, and the integrity hook from eng-media-assets. Needs a HeyGen credential category in
   `credentials/contract.ts` (not in this folder).
2. A hand-written EDL with one stock clip, one TTS voice track and three components (for example `captions.karaoke`,
   `title.hook`, `cta.card`). Render through the cloud. Check the MP4 is 1080 × 1920, 30 fps, duration within 100 ms,
   with audio. Record the render id, the video id, the ledger entries (estimate and actual) and the artifact ids.
3. Ten test renders. Record the real bill for each. Replace `budgets.fixedPerMasterUsd.render` (0.05) with the measured
   figure, and set `render_hyperframes_cloud` in `prices.ts` to a verified price.
4. Confirm `Idempotency-Key` behaviour: submit the same composition twice and check one render and one charge.
5. Check the endpoint shapes, `resolution` and `aspect_ratio` against the real responses (see `render/STATUS.md`).
6. Compare a local golden frame with the cloud output for the same composition (Bible 6.9: same output as the cloud).
7. Check font determinism. A kit that names a font outside the bundled set (for example Fraunces) is fetched from Google
   Fonts at render time.

## Decisions and interpretations (lead to confirm)

- Pinned `hyperframes@0.8.154` and `@hyperframes/core@0.8.154` exactly, as the brief said. npm's latest is 0.8.155; not
  adopted.
- The compiler writes sub-composition templates as full HTML documents (the CLI docs and the linter), not `<template>`
  wrappers (core.md). The linter accepts this with zero findings.
- `data-track-index` is set and so is `z-index` (the 0.8.154 CLI docs say track index is display only).
- `data-duration` on sub-composition hosts (linter treats it as the slot window). Not set on templates.
- GSAP is loaded from jsdelivr at 3.15.0, the version HyperFrames uses by default.
- Reserved prop `durationMs` is set by the compiler from the clip span. Components never receive a duration from Claude.
- Props named `*Uri` are media. The compiler maps them to local asset paths, so no EDL URI reaches the HTML.
- Caption highlight, weight and case come from the style kit (`--kit-caption-*`), not from props. The Bible's table lists
  a highlight prop; the brief's rule ("read only the style kit variables") wins.
- `speed_ramp`, and the `zoom` and `flash` transitions, are refused rather than dropped. W8 must not emit them until the
  compiler draws them.
- Music ducking is pre-rendered upstream. The compiler records nothing about `duckDb` in the HTML.
- `package-lock.json`: `npm install` rewrote the file's ordering. 170 packages were added (HyperFrames and its
  dependencies, including esbuild 0.28.2 at the top level). I compared the old and new lockfiles: no existing package
  version changed, and none was removed.

## Blockers

- No code blocker in this folder.
- Needs other workstreams before delivery: the render-integrity probe and rule (eng-media-assets, W4/W11), storage for
  `resolveAsset` and `storeVideo` (eng-pipeline, W2), and the HeyGen credential category (credentials, E2).
- Product beats need real imagery (L8). `product.card` without `heroUri` renders text only. The pre-render gate should
  refuse a product beat that has no hero image. That is W11's gate, not the compiler's.
