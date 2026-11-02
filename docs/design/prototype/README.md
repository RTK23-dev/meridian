# Mixed-plan prototype

A clickable prototype of the proposal in `docs/design/MERIDIAN_MIXED_DESIGN_PLAN.md`. One structure, two systems: the shipped look (AttentionOS, from `src/styles.css`) and the proposal (Katana tokens from `docs/design/tokens/katana-tokens.json`). The switch is at the top of the page.

All content is a sample. No provider was called and nothing ran. Costs, models and states are placeholders chosen to show every state.

The theme follows the system setting until a choice is made with the Dark or Light control, which then overrides it.

## Open it

Module scripts do not load from `file://`, so serve the folder:

    cd docs/design/prototype && python3 -m http.server 8080

then open http://localhost:8080/index.html.

## Test it

The model is pure and has no DOM. Its tests run with the rest of `npm test`:

    node --test "docs/design/**/*.test.mjs"

The model tests check the canvas geometry against `src/engine/orchestrator/layout.ts`, and the state words, kind labels and example goals against `src/components/content-factory/orchestrator-presentation.ts`. If the app's copy changes, they fail.

## Measure it

`capture.mjs` runs the page in headless Chromium and checks the 21 claims in the plan: theme following the system and an explicit choice, fonts, title tiers, layout position under the details panel, keyboard order and the skip link, restriction, layout shift on redraw, reduced motion, phone width and greyscale. It writes screenshots and `screens/measurements.json`, and exits non-zero if a claim fails.

    node docs/design/prototype/capture.mjs

It uses the pre-installed Chromium at `/opt/pw-browsers/chromium` and the `playwright` package from the environment. Google Fonts must be reachable for the faces to show; without it the page falls back to the system faces, and the font check fails.

## Publish it

The published Artifact is the same page with the stylesheet and both scripts inlined, so it is one file:

    node docs/design/prototype/build-artifact.mjs <output.html>

The build keeps the page content as it is in `index.html`, and the publish skeleton supplies the document wrapper.

## Files

- `index.html`, `prototype.css`, `app.mjs`: the page and its view controller. Text goes through `esc()`; no sample data reaches `innerHTML` unescaped.
- `model.mjs`, `model.test.mjs`: the sample plan, the layout, the state words, the cost rules and the reducer.
- `capture.mjs`: the browser checks and the screenshots.
- `build-artifact.mjs`: the single-file build for publishing.
- `screens/`: screenshots at 1440 and 390 px, both systems, both themes, plus `measurements.json`.
