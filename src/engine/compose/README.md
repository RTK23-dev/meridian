# engine/compose (W9)

Implements Bible section **9** (compiler and component library), **13** (style kit as CSS custom properties),
**6.9** (`compose` stage) and **17.3** (component and golden-frame tests). Phase E1, wave B.

## What is here

| Path | Bible | What it does |
| --- | --- | --- |
| `compiler.ts` | 9.1, 6.9 | `compile(edl, styleKit, components)` → `{ files, composition, assets }`. Pure and deterministic. |
| `styleKit.ts` | 9.1 rule 4, 13 | Style kit → `:root` custom properties (`--kit-*`). Refuses font names that could break CSS. |
| `library.ts` | 9.2 | `ComponentDefinition` and `ComponentFixture` types, the reserved `durationMs` prop. |
| `html.ts` | 9.1, L8 | Escaping for every string that reaches HTML (text nodes and JSON in attributes). |
| `components/<name>/` | 9.2 | `component.html` (template), `props.ts` (zod), `fixtures/` (3 prop sets), `index.ts` (definition), golden PNGs in `golden/`. |
| `components/components.test.ts` | 9.2 | Contract checks for every component (props, declared variables, no wall-clock or markup APIs, kit colours only). |
| `lint.test.ts` | 6.9 | Runs `hyperframes lint` on the compiled EDL fixture and on every component fixture. Zero errors and zero warnings. |
| `golden/` | 17.3 | Local render harness and the golden-frame runner (`npm run engine:golden`). Not in `npm test`. |
| `snapshots/edl-fixture/` | 17.3 | Snapshot of the compiled contracts EDL fixture (`UPDATE_SNAPSHOTS=1` rewrites it). |

Components shipped: E1 `captions.karaoke`, `title.hook`, `kinetic.punchline`, `product.card`, `cta.card`; E2 `react.layout`,
`list.tierBoard`, `compare.split`, `price.reveal`, `chat.thread`. The rest of the 9.2 list arrives in E5 (and later
phases).

## Output shape

- `index.html`: one root composition, `data-width="1080" data-height="1920"`, duration from the EDL. Tracks follow the
  layer stack (base 0 … stickers 5, audio on tracks 10 and up). Media clips are `<video muted>` or `<img>`. Component
  clips are sub-composition hosts (`data-composition-src`, `data-variable-values`). Transitions and effects are GSAP
  tweens on the root timeline.
- `style.css`: the kit's `:root` block and the shared layout rules.
- `components/<name>.html`: each used template, copied byte for byte.
- `assets.json`: the media map. Clips point at `assets/<16 hex>.<ext>`, never at the EDL URI, so no media URI is in the HTML.
- `Composition.contentHash` is `compositionHash(files)`: the hash of each file's bytes. It is the render idempotency key.
- Same EDL, kit and library give the same bytes and the same hash (tested).

## Rules the compiler enforces

- Clips on one layer must not overlap; no clip may run past the EDL duration; a layer may appear once.
- A clip has exactly one of `srcUri` or `component`. Clip ids use `[A-Za-z0-9_-]` and are unique.
- Transitions: `hard`, `fade`, `whip`. Effects: `punch_in`, `shake`, `flash`. Anything else is refused (`speed_ramp` is not
  yet drawn), so nothing is dropped silently.
- Audio gain must stay within HyperFrames' +12 dB (`data-volume` ≤ 3.98).
- Music ducking is pre-rendered upstream (9.1 rule 5). The compiler uses the stem as given and ignores `duckDb`.
- Each `*Uri` prop (and each string in a `*Uris` list) is a media URI, at any depth: a list item's image is mapped too.
  The compiler checks its kind and maps it to a local asset path, so no EDL URI reaches the HTML (tested).
  A component's own schema can narrow the kind (for example `imageUriSchema` in `components/shared.ts` refuses video).
- Component props are validated by the component's zod schema. The error names the clip.
- Every text value reaches the HTML as escaped text or escaped JSON. The HTML never receives raw ad or script text.

## HyperFrames version and the docs used

- Package: `hyperframes@0.8.154` and `@hyperframes/core@0.8.154` (exact, dev dependencies). Latest on npm at the time was
  0.8.155; the brief pinned 0.8.154.
- Read from the installed packages (`node_modules/…`):
  - `hyperframes/README.md` (CLI commands: `render`, `lint`, `cloud render` in `dist/cloud-FIELJ5XR.js`).
  - `hyperframes/dist/docs/compositions.md`, `data-attributes.md`, `rendering.md`, `troubleshooting.md`.
  - `@hyperframes/core/docs/core.md`, `common-mistakes.md`, `core_notes.md`.
  - `@hyperframes/lint/dist/index.js` (rule codes and messages), `@hyperframes/parsers` (variable types).
- Documentation sites named by the packages: https://github.com/heygen-com/hyperframes (packages/cli, packages/core),
  https://hyperframes.heygen.com/packages/cli, https://hyperframes.heygen.com/packages/core. I did not fetch the GitHub raw
  files in this round; the installed packages were the source.

## Where the docs disagree, and what the compiler does

1. **`data-track-index`.** core.md says tracks decide layering. The 0.8.154 CLI docs say it is display only and paint
   order is CSS `z-index`. The compiler sets both: the track index for lanes, and `z-index` = layer order + 1.
2. **`data-duration` on a sub-composition host.** core.md says compositions have no `data-duration`. The CLI docs and the
   0.8.154 linter treat it as the slot's visible window. The compiler sets it on hosts only, never on a template root.
3. **Sub-composition file format.** core.md shows a `<template>` wrapper. The CLI docs show a full HTML document with
   `<html data-composition-variables>`. The linter accepts the full document and rejects a `<template>` on a root. The
   compiler writes the full document.
4. **Props as template variables.** Declarations go on the template's `<html data-composition-variables>` (scalar props
   only). Values go on the host as `data-variable-values` (JSON, arrays included). A component reads them with
   `window.__hyperframes.getVariables()`. Verified by local renders with two instances of one template and an array prop.
5. **GSAP.** Loaded from `https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js`, the version the HyperFrames
   core uses by default (`gsapCdn.js`). Every timeline is paused, registered on `window.__timelines`, and finite (no
   `repeat: -1`).

## Components: rules every template keeps

- Seekable: all motion is GSAP on the composition clock (`tl.set` and `tl.fromTo` at fixed times). No
  `requestAnimationFrame`, no timers, no `Math.random`, no `Date.now`, no `fetch`.
- Kit only: colours and fonts come from `var(--kit-*)`, read through `getComputedStyle(document.documentElement)`.
  The only literal colour is the black `rgba(0, 0, 0, a)` shadow. A test enforces this.
- Text is set with `textContent`. No `innerHTML`.
- Safe zones (8.3): caption, title and punchline boxes span 6% to 88% of the width, so the right 12% stays clear. The
  lower caption band starts at 60% of the height and the lower title band at 52%, so text stays above the bottom 20%.
  Graphic boxes (product card, CTA card) fill the EDL `box` they are given. The editor and the pre-render gate must keep
  those boxes clear: the contracts fixture's graphics boxes run to x = 1020, past the 88% line, and the compiler does not
  judge that.
- Layout is in percentages of the component's own box, so an EDL `box` on the host places the whole component (verified).

## Golden frames

`npm run engine:golden` renders each fixture locally with the HyperFrames CLI (Chrome headless shell via
`HYPERFRAMES_BROWSER_PATH`, ffmpeg for frame extraction) and compares each frame with its PNG. Pass means under 1% of
pixels differ by more than 16 in any channel. `npm run engine:golden:update` writes the PNGs again; review them by eye.
Golden renders use the bundled Inter font only (no font fetch at render time).

Golden media is placeholder media, never product or person photography. `test/golden/harness.ts` draws each image as a
gradient with a disc in a colour chosen by the file's base name (`hero`, `before`, `after`, `base`, `presenter`), and
writes each video as a short solid-colour VP8 clip made with ffmpeg (`FFMPEG_PATH`, or `ffmpeg` on the PATH). That
exercises a component's own `<video>` path (picture-in-picture, wipes). The lint tests (`mode "lint"`) write empty
files for video, so `npm test` needs no ffmpeg.

Timing in a component: a `<video>` inside a sub-composition has `data-start` 0, its duration, `data-media-start` for
the in-point, and `muted`. A picture-in-picture box is a plain wrapper that GSAP animates; the media fills it (the
HyperFrames common-mistakes guide). Text is set with `textContent`, so markup in an ad or script reaches the frame as
text.

## Not in this round

- `remotionLambda` and `shotstack` compilers (9.3). They come with E5.
- The `VideoEngine` adapter (Meridian's interface is Hypit-shaped; see `render/STATUS.md`).
- Kit fonts other than the bundled set (for example Fraunces) are fetched by HyperFrames at render time. That is a
  determinism risk the owner should check in the live run.
