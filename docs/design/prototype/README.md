# Mixed-plan prototype

A prototype of the proposal in `docs/design/MERIDIAN_MIXED_DESIGN_PLAN.md`, set out as small plates. Each plate is one part of the design, with what it does and what it means. One structure, two systems: the shipped look (AttentionOS, from `src/styles.css`) and the proposal (Katana tokens from `docs/design/tokens/katana-tokens.json`). The switch is at the top of the page.

All content is a sample. No provider was called and nothing ran. Costs, models and states are placeholders chosen to show every state.

The theme follows the system setting until a choice is made with the Dark or Light control, which then overrides it.

## Open it

Module scripts do not load from `file://`, so serve the folder:

    cd docs/design/prototype && python3 -m http.server 8080

then open http://localhost:8080/index.html.

## Test it

The model is pure and has no DOM. Its tests are in `scripts/design-prototype-model.test.mjs` (20 tests, including the copy for each state and cost), so `npm test` and the CI shards run them with the other script tests:

    node --test scripts/design-prototype-model.test.mjs

The model tests check the canvas geometry against `src/engine/orchestrator/layout.ts`, and the state words, kind labels and example goals against `src/components/content-factory/orchestrator-presentation.ts`. If the app's copy changes, they fail.

## Measure it

`capture.mjs` runs the page in headless Chromium and checks the 28 claims in the plan: the theme, fonts, title tiers, the brief, the details panel, the shared selection, the overview map, the keyboard, restriction, layout shift on redraw, reduced motion, the phone, and the state copy. It writes screenshots and `screens/measurements.json`, and exits non-zero if a claim fails.

    node docs/design/prototype/capture.mjs

It uses the pre-installed Chromium at `/opt/pw-browsers/chromium` and the `playwright` package from the environment. Google Fonts must be reachable for the faces to show; without it the page falls back to the system faces, and the font check fails.

## Publish it

The published Artifact is the same page with the stylesheet and both scripts inlined, so it is one file:

    node docs/design/prototype/build-artifact.mjs <output.html>

The build bundles `model.mjs`, `mount.mjs` and `app.mjs` into one script, in that order, and keeps the page content as it is in `index.html`. The publish skeleton supplies the document wrapper.

## Files

- `index.html`, `prototype.css`: the page of plates and its styles.
- `mount.mjs`: the plan component. It is mounted in each plate that shows a plan, with only the controls that plate asks for.
- `app.mjs`: the page controller. It mounts the plans, builds the state and cost plates from the model, and wires the brief and the switches. Text goes through `esc()`; no sample data reaches `innerHTML` unescaped.
- `model.mjs`: the sample plan, the layout, the state words, the cost rules and the reducer. Its tests are `scripts/design-prototype-model.test.mjs`.
- `capture.mjs`: the browser checks and the screenshots.
- `build-artifact.mjs`: the single-file build for publishing.
- `screens/`: screenshots of the page (1440 and 390 px, both themes, the shipped look), plus `measurements.json`.
