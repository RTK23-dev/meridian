# Mixed-plan prototype

A prototype of the proposal in `docs/design/MERIDIAN_MIXED_DESIGN_PLAN.md`, set out as small plates. Each plate is one part of the design, with what it does and what it means. One structure, two systems: the shipped look (AttentionOS, from `src/styles.css`) and the proposal (Katana tokens from `docs/design/tokens/katana-tokens.json`). The switch is at the top of the page.

All content is a sample. No provider was called and nothing ran. Costs, models and states are placeholders chosen to show every state.

The theme follows the system setting until a choice is made with the Dark or Light control, which then overrides it.

## Open it

Module scripts do not load from `file://`, so serve the folder:

    cd docs/design/prototype && python3 -m http.server 8080

then open http://localhost:8080/index.html for the plates, or http://localhost:8080/presentation.html for the walkthrough of the full web design: fourteen screens and a cover, each with what it does, what it means, and what was checked on it. The walkthrough moves with Previous and Next, the arrow keys, or `#screen-id` in the address, and its Desktop and Phone control sets the frame width.

## Test it

The model is pure and has no DOM. Its tests are in `scripts/design-prototype-model.test.mjs` (20 tests, including the copy for each state and cost), so `npm test` and the CI shards run them with the other script tests:

    node --test scripts/design-prototype-model.test.mjs

The model tests check the canvas geometry against `src/engine/orchestrator/layout.ts`, and the state words, kind labels and example goals against `src/components/content-factory/orchestrator-presentation.ts`. If the app's copy changes, they fail.

## Measure it

`capture.mjs` runs the page in headless Chromium and checks the 28 claims in the plan: the theme, fonts, title tiers, the brief, the details panel, the shared selection, the overview map, the keyboard, restriction, layout shift on redraw, reduced motion, the phone, and the state copy. It writes screenshots and `screens/measurements.json`, and exits non-zero if a claim fails.

    node docs/design/prototype/capture.mjs

The walkthrough has its own checks: `capture-presentation.mjs` runs nine claims over the fourteen screens (each renders and is indexed, at most one red action, every disabled control says why, no sideways scroll at 1440 and 390, the phone layout, the keys, and a step chosen on the plan opens its details). It writes one PNG per screen into `presentation-screens/`, and `presentation-measurements.json`. It exits non-zero if a claim fails.

    node docs/design/prototype/capture-presentation.mjs

It uses the pre-installed Chromium at `/opt/pw-browsers/chromium` and the `playwright` package from the environment. Google Fonts must be reachable for the faces to show; without it the page falls back to the system faces, and the font check fails.

## Publish it

The published Artifact is the same page with the stylesheet and both scripts inlined, so it is one file:

    node docs/design/prototype/build-artifact.mjs <output.html> [index|presentation]

`index` (the default) bundles `model.mjs`, `mount.mjs` and `app.mjs`, in that order, and keeps the page content as it is in `index.html`. `presentation` bundles `model.mjs`, `mount.mjs`, `screens.mjs` and `presentation.mjs`, with `prototype.css` and `presentation.css`. The build stops if a top-level name is declared twice, since the modules share one scope in the page. The publish skeleton supplies the document wrapper.

## Files

- `index.html`, `prototype.css`: the page of plates and its styles.
- `mount.mjs`: the plan component. It is mounted in each plate that shows a plan, with only the controls that plate asks for.
- `app.mjs`: the page controller. It mounts the plans, builds the state and cost plates from the model, and wires the brief and the switches. Text goes through `esc()`; no sample data reaches `innerHTML` unescaped.
- `model.mjs`: the sample plan, the layout, the state words, the cost rules and the reducer. Its tests are `scripts/design-prototype-model.test.mjs`.
- `capture.mjs`: the browser checks and the screenshots.
- `build-artifact.mjs`: the single-file build for publishing, for either entry.
- `screens/`: screenshots of the plates (1440 and 390 px, both themes, the shipped look), plus `measurements.json`.
- `presentation.html`, `presentation.css`, `presentation.mjs`: the walkthrough of the full web design. It has an index of the fourteen screens and a stage that draws each one in a frame that is its own container, so a frame reflows by the width it has.
- `screens.mjs`: the fourteen screens and the cover: their markup, copy and notes. Every screen's red action is counted by the capture. Its `esc` comes from `mount.mjs`.
- `capture-presentation.mjs`: the walkthrough's nine claims and its screenshots.
- `presentation-screens/`: one PNG per screen, four phone frames, and `presentation-measurements.json`.
