# STATUS: engine compose (W9): compiler, style kit, thirteen components, golden frames

## E5: three visual-type components (`kinetic.type`, `screen.mock`, `character.rig`) on branch `eng-e5-visual-types`

Cut from `code/beautiful-cori-1zfk11` (d5a62c1). The compiler, the style kit and `html.ts` are unchanged (no contract change).

- **`kinetic.type`**: full kinetic typography beyond kinetic.punchline. Lines of script text, one on screen at a time, each
  until the next starts. Words arrive in sequence (`stagger`) or the line pops in (`pop`). Emphasis words take the kit accent
  and a punch. Up to six lines, 24 words in all, 40 characters a line, four emphasis words. Text is drawn with `textContent`.
- **`screen.mock`**: a phone or desktop UI mock. A discriminated union on `screen`: `notification` (app, headline, body, time
  label, optional icon), `app` (title, up to four labelled rows, optional picture) or `chat` (up to six messages on either
  side). Pictures are image URIs only, and the compiler maps them to local assets.
- **`character.rig`**: one SVG rig (`bean.v1`) drawn by its template from named parts: head, brows, eyes with lids, two arms,
  torso, legs, five mouth shapes (`closed`, `open`, `wide`, `round`, `teeth`). Six poses (`idle`, `point`, `shrug`, `cheer`,
  `think`, `surprise`) and four expressions (`neutral`, `happy`, `surprised`, `annoyed`) from fixed libraries in the template.
  Props give a pose timeline and a mouth timeline on the clip clock, with fixed blinks every 2.6 s. Colours come from the kit
  only. No pixels are generated or fetched. The character sheet's `rigUri` (an SVG file) is not drawn: the compiler does not
  read SVG and components may not fetch. The rig's names are the contract between the sheet and the component.
- Golden frames: 16 PNGs (`kinetic.type` 5, `screen.mock` 5, `character.rig` 6) written with the golden harness and viewed
  by eye (not every frame; see `components/STATUS.md`). `npm run engine:golden`, with the local headless shell from
  `/opt/pw-browsers`: **39 fixtures pass, 0 fail** (30 existing, 9 new). The lint tests (`hyperframes lint`) pass for all 39
  fixtures and the EDL fixture. `npm run typecheck` exits 0. `npm run lint` exits 0 with 0 errors and the same four warnings
  in `src/components/` that were there before E5.
- Tests: `components/e5.test.ts` (prop limits, escaping through the compiler, media mapping, a three-component composition
  that compiles to the same hash twice), and the contract checks in `components/components.test.ts` now cover all thirteen.
- Fixes found by viewing the frames: the rig's `fromTo` and `set` calls use `immediateRender: false` (GSAP would otherwise
  apply the last state at build time, so the first frames showed the wrong pose and mouth); the `think` arm and the surprised
  brow height were corrected; the emphasis punch was reduced so a scaled word no longer covers its neighbour's space.

### Owner's live run for E5 (agents hold no keys)

No component has a provider cost; the ledger records only the cloud render. The owner runs one composition holding one clip of
each new component through the HeyGen HyperFrames cloud, and checks, against the golden frames for the same composition:

1. `kinetic.type`: the stagger and the pop entrance, and the emphasis colour and punch, in the cloud frames.
2. `screen.mock`: a notification on a phone with a real product icon, an app screen with a product picture, a desktop chat.
   The markup message shows as text.
3. `character.rig`: the arms, the brows, the blinks and the five mouth shapes move on the clock. The cloud frames match the
   local golden frames within the 1% pixel rule (Bible 17.3), for the same composition (Bible 6.9).
4. Record the render id, the video id, the ledger entries (estimate and actual) and the artifact ids. Font check as E1: the kit's
   fonts are bundled, and the golden fixtures use Inter only.

## E2: five more components (`react.layout`, `list.tierBoard`, `compare.split`, `price.reveal`, `chat.thread`)

Phase E2 (W9, the second component set) on branch `eng-e2-components`, cut from `code/beautiful-cori-1zfk11` (a4b04c7).
Phase E1 history below. Covers `src/engine/compose/` (and the `components/`, `golden/` and `snapshots/` folders inside
it). Details: `README.md` in this folder.

## E2: five more components (`react.layout`, `list.tierBoard`, `compare.split`, `price.reveal`, `chat.thread`)

- Each follows the E1 pattern: `component.html`, `props.ts` (zod), `fixtures/` (3 prop sets), `index.ts`, golden PNGs.
  The library now holds ten components (`components/index.ts`). Per-component decisions are in `components/STATUS.md`.
- Compiler change (`compiler.ts`): every `*Uri` and `*Uris` prop is mapped to a local asset at any depth, so a list
  item's image cannot leak its EDL URI into the HTML. Compositions with no nested URIs compile to the same bytes as E1
  (the EDL snapshot test is unchanged and passes).
- Price text is formatted by code from integer minor units (`price.reveal/props.ts`, `formatPrice`, tested). Chat text
  and every other value reaches the HTML escaped (tested with markup in a message, an item name and a label).
- Golden harness (`test/golden/harness.ts`): placeholder images are coloured gradients chosen by name; video slots get a
  generated VP8 placeholder (ffmpeg), so the components' own `<video>` path is rendered. `mode "lint"` writes empty
  files for video, so `npm test` needs no ffmpeg. The product hero frame is unchanged.
- Tests run here (`NODE_ENV=development node --experimental-strip-types --test 'src/engine/compose/**/*.test.ts'`):
  **163 pass, 0 fail, 0 skipped.** That includes `components/e2.test.ts` (new), `components/components.test.ts`,
  `compiler.test.ts`, `styleKit.test.ts`, and `lint.test.ts` (`hyperframes lint` on the EDL fixture and all 30 component
  fixtures: 31 of 31 with zero errors and zero warnings; the CLI runs here, so nothing was skipped).
- `npm run typecheck`: exit 0. `npm run lint`: exit 0, 0 errors, 4 warnings, all in existing `src/components/` files
  (the same four as before this change). `npx eslint src/engine/compose`: exit 0.
- Golden frames: `npm run engine:golden:update` wrote 35 PNGs (15 from E1, unchanged byte for byte, and 20 new), then
  `npm run engine:golden` (with `HYPERFRAMES_BROWSER_PATH` set to the local headless shell): **30 pass, 0 fail** across
  the ten components. The `list.tierBoard` frames were regenerated once after a fix to the text-only card names (a
  scratch run for that one component; its three fixtures were rerun and checked by eye).
- Full `npm test` is the lead's to run after merging (not run in this worktree, per the brief).

### Owner's live run for E2

Agents hold no keys. The owner renders one composition with a clip of each new component through the HeyGen cloud, and
checks: the `react.layout` video plays in sync inside the sub-composition; `compare.split` wipes in with its video; the
`list.tierBoard` item images are real product imagery (L8); and the cloud frames match the local golden frames for the
same composition (Bible 6.9). Record the render id, the video id, the ledger entries and the artifact ids. The list is in
`components/STATUS.md`.

## E1 (history)

Phase E1, wave B. Branch `engine/e1-w9-w10`, cut from `code/beautiful-cori-1zfk11` (7fd32ae).

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
