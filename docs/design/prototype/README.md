# Mixed-plan prototype

A prototype of the design in `docs/design/MERIDIAN_MIXED_DESIGN_PLAN.md`, set out as small plates. Each plate is one part of the design, with what it does and what it means. There is one design system, the Katana tokens from `docs/design/tokens/katana-tokens.json`. The shipped AttentionOS look is not offered here.

All content is a sample. No provider was called and nothing ran. Costs, models and states are placeholders chosen to show every state.

The theme follows the system setting until a choice is made with the Dark or Light control, which then overrides it.

The accent is the colour of the one action, the focus and the selected state. It is red by default. The Accent colour control chooses one of five presets (red, blue, violet, teal, magenta), and the choice changes the accent everywhere on the page, in both themes. The danger colour does not change, because it marks a state, not the accent. Each preset passes the contrast rules in `accent.mjs` in both themes, and the model tests check that, so a preset that fails cannot be added. The choice is kept on this device only.

## Open it

Module scripts do not load from `file://`, so serve the folder:

    cd docs/design/prototype && python3 -m http.server 8080

then open http://localhost:8080/index.html for the plates, or http://localhost:8080/presentation.html for the walkthrough of the web design: forty-eight screens and states, plus a cover, each with what it does, what it means, and what was checked on it. The walkthrough moves in the order the index lists the screens, with Previous and Next, the arrow keys, or `#screen-id` in the address. Its Desktop and Phone control sets the frame width.

## Test it

The model is pure and has no DOM. Its tests are in `scripts/design-prototype-model.test.mjs` (20 tests, including the copy for each state and cost), so `npm test` and the CI shards run them with the other script tests:

    node --test scripts/design-prototype-model.test.mjs

The model tests check the canvas geometry against `src/engine/orchestrator/layout.ts`, and the state words, kind labels and example goals against `src/components/content-factory/orchestrator-presentation.ts`. If the app's copy changes, they fail.

## Measure it

`capture.mjs` runs the page in headless Chromium and checks the 28 claims in the plan: the theme, fonts, title tiers, the brief, the details panel, the shared selection, the overview map, the keyboard, restriction, layout shift on redraw, reduced motion, the phone, and the state copy. It writes screenshots and `screens/measurements.json`, and exits non-zero if a claim fails.

    node docs/design/prototype/capture.mjs

The walkthrough has its own checks: `capture-presentation.mjs` runs its claims over every position in the index, read from the page itself (the cover and 48 screens and states). Each renders and is indexed, at most one red action, every disabled control says why, no sideways scroll at 1440 and 390, the phone layout, the keys, a step chosen on the plan opens its details, and the site background behind it: its two colours, its move to each group's stop, and the holds. It writes one PNG per screen into `presentation-screens/`, and `presentation-measurements.json`. It exits non-zero if a claim fails.

    node docs/design/prototype/capture-presentation.mjs

It uses the pre-installed Chromium at `/opt/pw-browsers/chromium` and the `playwright` package from the environment. Google Fonts must be reachable for the faces to show; without it the page falls back to the system faces, and the font check fails.

## Publish it

The published Artifact is the same page with the stylesheet and both scripts inlined, so it is one file:

    node docs/design/prototype/build-artifact.mjs <output.html> [index|presentation]

`index` (the default) bundles `model.mjs`, `mount.mjs` and `app.mjs`, in that order, and keeps the page content as it is in `index.html`. `presentation` bundles `model.mjs`, `mount.mjs`, `accent.mjs`, `screens.mjs`, `screens-start.mjs`, `screens-workspace.mjs`, `screens-settings.mjs`, `screens-brand.mjs`, `screens-all.mjs`, the three map modules from `meridian-map/` (`world-field.mjs`, `map-model.mjs`, `halftone.mjs`), `background.mjs` and `presentation.mjs`, with `prototype.css` and `presentation.css`. The modules come in that order because the page shares one scope. The build stops if a top-level name is declared twice, since the modules share one scope in the page. The publish skeleton supplies the document wrapper.

## Files

- `index.html`, `prototype.css`: the page of plates and its styles.
- `mount.mjs`: the plan component. It is mounted in each plate that shows a plan, with only the controls that plate asks for.
- `app.mjs`: the page controller. It mounts the plans, builds the state and cost plates from the model, and wires the brief and the switches. Text goes through `esc()`; no sample data reaches `innerHTML` unescaped.
- `model.mjs`: the sample plan, the layout, the state words, the cost rules and the reducer. Its tests are `scripts/design-prototype-model.test.mjs`.
- `capture.mjs`: the browser checks and the screenshots.
- `build-artifact.mjs`: the single-file build for publishing, for either entry.
- `screens/`: screenshots of the plates (1440 px in both themes, and 390 px in dark), plus `measurements.json`.
- `accent.mjs`: the accent presets, the contrast helpers, and the control that chooses one and keeps it. Both pages use it.
- `presentation.html`, `presentation.css`, `presentation.mjs`: the walkthrough of the web design. It has an index of its screens and a stage that draws each one in a frame that is its own container, so a frame reflows by the width it has.
- `screens.mjs`: the shared pieces (heads, tabs, tables, switches, sliders, notices, fields, plates), the first twelve screens, and the cover. Its `esc` comes from `mount.mjs`.
- `screens-start.mjs`: the invitation, the product, docs and quickstart pages, and the not-found, no-access and admin-only states.
- `screens-workspace.mjs`: the workspace overview, the alerts center, exports, and a new brand.
- `screens-settings.mjs`: the six tabs of Settings (General, Members, Scoring weights, Alerts, Learning, Danger zone) and the pages it links to: billing, usage, integrations, setup, jobs, engine operations, audit, webhooks and notifications.
- `screens-brand.mjs`: the brand pages: the brand overview, content, cookbooks, the orchestrator, the brain, products, pages, market, intelligence and calibration.
- `screens-all.mjs`: the order of the screens, and the index groups (Start, Home, Create, Library, Insights, Settings, States, Overlay). Each screen's red action is counted by the capture.
- `background.mjs`: the site background behind the walkthrough. It draws the map from `meridian-map/` with the site's settings, and moves it to the stop of the group on show: Start and Home at 47° N, Create at 23° N, Library at the equator, Insights at 23° S and Settings at 41° S. States and Overlay hold the place the walkthrough was at. It is tested in `scripts/meridian-background.test.mjs`.
- `capture-presentation.mjs`: the walkthrough's claims and its screenshots.
- `presentation-screens/`: one PNG per screen, four phone frames, and `presentation-measurements.json`.
