# Meridian mixed design plan: Katana, Onlab's distances and Sanity's mechanisms

Status: proposal for owner review. Written 2026-11-02. This document changes no app code. It adds the proposed token file (`docs/design/tokens/katana-tokens.json`), a prototype in `docs/design/prototype/`, set out as small plates (each part, with what it does and what it means), and the Sanity evidence in `docs/design/research/sanity/`. Open the prototype from `docs/design/prototype/README.md`.

Scope: the design system, the Create flow (Brief, Plan, step details), the component states and the accessibility rules. Home, Library, Insights and Settings are covered only where the mixed rules change them (section 4.6).

---

## 0. The decisions in one page

1. **The base is Katana.** Red is the one accent, the room is black or white, corners are 2 px, edges are hairlines, numbers are mono, and motion explains a change. The owner decided these in `KATANA_REDESIGN_PLAN.md` section 13 and section 14.7. This plan does not reopen them.
2. **One thread through every view.** The selected step is the identity of the plan. Its 2 px red mark is the same on the canvas, the strip, the list row and the details panel. Changing the view changes the representation, never the step. Onlab's principle "change the representation while preserving the identity", applied to a plan.
3. **Two axes, four distances.** Horizontal is dependency (what a step reads, and what reads it). Vertical is "runs alongside" (steps in the same column, in plan order). Distances: canvas (the whole plan), strip (the plan as a ribbon), list (the index), details (one step, with its context attached). The axes come from `src/engine/orchestrator/layout.ts`, not from a new layout.
4. **Words before colour.** Every state is a word, a dot shape and a tone. The colour-off test in the prototype reads all ten states.
5. **Titles follow their container, not the window.** Sanity's tiered heading is adopted, but the tier is set by the space the screen actually has. Opening the assistant, which pushes the page, steps the title down. The shipped app steps by the window, so it does not.
6. **Overlay for spatial screens, push for reading screens.** The details panel overlays the canvas so the plan never moves under the reader. The assistant pushes the brief, which is a reading column.
7. **On a phone the canvas becomes the list.** The same steps in the same order, in a unit that fits the width. The canvas is not shrunk. This changes Katana section i, which kept a scrolling canvas frame on phones. It is an owner decision (section 13).
8. **Reduced motion is global.** Meridian's shipped global rule already keeps colour fades. Sanity's per-component rule is partial, and its hero marquee keeps moving under reduced motion. The mixed plan keeps the global rule and tests that no infinite animation runs.
9. **Not adopted:** Sanity's scroll-linked header (Katana forbids scroll-linked effects), its wide-gamut brand colour (its contrast is unverified), and its hidden theme shortcut (the shortcut is listed under "?", not hidden).

### Corrections to the Katana plan

These are found by reading it against the code and by running the checks. Section 11 has the full list. The most important:

- **The focus ring on a red fill.** Katana section j makes it white. On the light page that ring is 1.00:1, so it disappears. The ring is `fg-primary` instead: 19.80:1 on light, 21.00:1 on dark.
- **Section e says the global reduced-motion rule cuts every transition.** It does not. `src/styles.css` line 332 keeps colour and opacity fades at 120 ms.
- **The node-state table omits "Queued at the provider".** The app defines it (`orchestrator-presentation.ts:60`), so the design must too.
- **State words are sentence case in the app, uppercase in Katana.** This plan follows the app, and keeps NOT CONNECTED in capitals because the engine writes it that way.

---

## 1. Evidence and limits

### 1.1 Sources

| Source | What it is | Where it lives |
|---|---|---|
| Onlab deep dive | A 33-page study of onlab.ch in the Swiss futura method. Principles in section 22 (PDF page 31, printed page 30). The organising idea on PDF page 4. Identity surviving the change of view on PDF page 5. Stable loading on PDF pages 28 and 29. | Uploaded PDF, read in full. Its page numbers are cited throughout. |
| Sanity deep entry | A deep study of sanity.io: 30 recorded states, 16 hashed sources, 12 verified source excerpts with byte offsets, a keyboard path, reduced motion, loading and responsive probes. | `docs/design/research/sanity/ENTRY.md` and its JSON evidence in the same folder. Raw assets (fonts, JavaScript, video, screenshots) are not in the repo. Their licences are the site's. |
| Katana plan | The owner's design language, the token base and the migration. | `docs/design/KATANA_DESIGN_PLAN.md`, `docs/design/KATANA_REDESIGN_PLAN.md` |
| Shipped app | The AttentionOS system as the app runs today. | `src/styles.css`, `docs/design/tokens/attentionos-tokens.json`, `src/components/content-factory/orchestrator-presentation.ts`, `src/engine/orchestrator/layout.ts` |

### 1.2 What the checks established

Each claim below has a test, a measurement, or both, and a file a reviewer can open.

- The proposed tokens: 35 colour pairs meet their minimum in both themes, using the repo's own helper (`src/lib/meridian/a11y/contrast.ts`). Every ratio the Katana plan states in its colour table is the computed ratio, to two decimal places. The JSON matches the Katana plan's CSS block. (`src/lib/meridian/a11y/katana-tokens.test.ts`, 5 tests.)
- The model: the canvas geometry equals `layout.ts`. The ten state words and the ten kind labels equal the app's strings. The example goals equal the app's. Selection survives every change of view. A filter never hides the selected step silently. A recorded zero shows as `$0.0000`, never "not recorded". (`scripts/design-prototype-model.test.mjs`, 20 tests, including the copy for each state and cost.)
- The rendered prototype, measured in headless Chromium by `docs/design/prototype/capture.mjs` (28 claims, all hold):
  - The theme follows the system setting when nothing is chosen, and an explicit Dark or Light choice overrides it.
  - Archivo, Instrument Sans and JetBrains Mono resolve (`document.fonts.check`). The browser supports `text-box: trim-both cap alphabetic`, and the buttons use it.
  - Titles follow their space. A title in a full-width column is 36 px and in a sixty-percent column 28 px. The masthead is 104 px on a wide window and 44 px on a phone.
  - Opening the assistant narrows the brief's column by more than 200 px. The plan on the page does not move.
  - Opening the step details does not move the step's layout position (`offsetLeft`, `offsetTop`). The selected step's right edge stays 16 px clear of the overlay, and the step's title takes focus. Escape closes the details and returns focus to the step.
  - A step chosen in one plate is selected in every other plate on the page (the thread).
  - The overview is a map above its canvas. A click on the map moves the canvas to that place.
  - The skip link is the first stop in the focus order. Tab walks the eight steps in reading order. With the plan focused, arrow keys scroll it.
  - "Needs you" reads "Showing 2 of 8 steps". Selecting a hidden step clears the filter and says so.
  - Redrawing the plan produces a layout shift of 0 (Chromium's Cumulative Layout Shift).
  - Under reduced motion, no infinite animation runs.
  - At 390 px the page has no horizontal scroll. The plan is drawn as its list, in the same order, and its details rise as a sheet.
  - One red-filled button in the brief.
  - The ten states and the four cost tiles are present, and each state has a distinct word, a meaning and a next step.
  - Colour off applies to the page.

### 1.3 What the checks did not establish

- No live Meridian data, no real provider, no real plan. Every number in the prototype is a sample, labelled as such in the page.
- Browsers: Chromium only. Safari and Firefox are not tested. `text-box` is not supported everywhere (Firefox), so the trim rule is progressive: where unsupported, the control keeps its padding.
- Assistive technology: no screen reader was run. The ARIA is written to the patterns in section 9, and the accessible names are checked in the model.
- Hardware: no phone, no touch screen, no GPU.
- The six Katana screens outside the Create flow (Home, Library, Insights, Settings, login, the logo) are described in this plan but not built here.

---

## 2. What each source contributes

### 2.1 Onlab (the ten principles, PDF page 31)

Each principle is adopted, with a Meridian meaning, a prototype test, and what it does not cover.

| Principle | Meridian meaning | Where it shows | Test |
|---|---|---|---|
| Identity-preserving representation | A step keeps its identity and its selection through canvas, strip, list and details. | Selection mark, `reduce()` | `scripts/design-prototype-model.test.mjs` selection tests; capture: keyboard and overlay |
| Semantic axes | Horizontal means the reading relation. Vertical means runs alongside. | `layoutSteps()`, column = dependency depth | layout tests |
| Representation distance | Four distances for one plan: canvas, strip, list, details. | Segmented control, details panel | identity tests across views |
| Positional hierarchy | Kind top left, state word top right, title, model, cost, in the same place on the card, strip card and details. | `.node`, `.strip-card`, `#drawer` | visual, section 9 |
| Content-bearing colour | The colour of a plan comes from its work (a still, a clip), not from the interface. Kind colours are removed from the chrome. | Kind colours removed (section 6.4). No media in the prototype, so this is a rule, not a demonstration. | rule, not measured |
| Attached context | Model, cost, reads, read-by and the reason sit beside the step, in the details panel. Nothing navigates the reader away. | `renderDrawer()` | capture: overlay |
| Responsive recomposition | At phone width the browsing unit becomes the step, not the canvas. | Phone list, section 7.3 | capture: phone list and sheet |
| Temporal hierarchy | Confirmations leave by themselves after 4 s. Warnings and failures stay until closed. Hover pauses the timer. | `toastDuration()` | `scripts/design-prototype-model.test.mjs` toast policy |
| Visible restriction | A filter names what it shows and how many. Its reset is one control. A hidden selection never fails silently. | `restrictionText()`, `reduce("select")` | capture: restriction |
| Stable loading geometry | The skeleton has the same boxes as the loaded steps. The restriction line and the notice slot reserve their space. | Skeleton, reserved slots | capture: CLS 0 |

Limits. Onlab is an editorial archive with a custom pointer and a 34vw word. The principles transfer as structure. The archive's visual choices do not.

### 2.2 Sanity (the mechanisms, ENTRY.md)

| Mechanism (ENTRY.md) | Decision | Reason | Test |
|---|---|---|---|
| Tiered heading by container (§7, §12) | **Adopt**, with container queries instead of window breakpoints | The space a screen has is what matters. The agent panel shrinks it (§4). | capture: title tier |
| Trim to the cap height, `text-box: trim-both cap alphabetic` (§7, G1) | **Adopt**, progressive | Centres mono and text controls on their cap height. Unsupported browsers keep padding. | capture: `text-box` support |
| Coupled chrome: the assistant pushes the page and the heading steps down (§4, D05) | **Adopt for reading screens only** | Pushing a canvas moves every step under the cursor. Onlab's stable geometry rules that out. | capture: body width and title size |
| Progressive colour: wide-gamut brand with an sRGB fallback (§9, G6) | **Reject** | The contrast of a wide-gamut red cannot be checked against the sRGB value the plan verifies. A second red is an unverified colour. | none; reason recorded |
| Scroll-linked header (§4, Navbar script) | **Reject** | Katana section e forbids scroll-linked effects, and Meridian's shell is a workspace, not a marketing page. | none |
| Named motion budget, but per component (§11, R01) | **Adapt**: one global rule | Sanity's rule is partial and its marquee keeps moving under reduced motion. Meridian's global rule is already complete. | capture: no infinite animations |
| Hidden theme shortcut, Shift+L (§13) | **Adapt**: documented under "?" | A feature that cannot be found is not a feature. | keyboard list in the Components screen |
| Mega-menu buttons without `aria-expanded` (§13, aria.json) | **Adopt the check**: every disclosure exposes its state | The assistant toggle sets `aria-expanded` in the prototype. | section 9 checklist |
| Agent panel uses the tab pattern correctly (§13) | **Adopt where tabs exist**: `role="tablist"`, roving `tabindex`, arrow keys | The prototype has no tabs now. Its contents rail marks the chapter in view with `aria-current`. | keyboard check |
| Skip link fourth in the focus order (§13) | **Adopt the rule**: the skip link is the first stop | Keyboard path | section 10 |
| Layout stable under load, CLS 0 (§14) | **Adopt** | Matches Onlab's stable loading geometry | capture: CLS 0 |
| Demonstration, not decoration (§16) | **Adopt as a rule** | The empty and login states show a real state, labelled as an example, not an ornament | section 4.6 |

### 2.3 Katana (kept, with corrections)

Kept as written: the black room, red as "now", 2 px corners, hairline edges, no shadows, mono numbers, the est./recorded rule, the 10 kinds, the 4 px spacing scale, the type scale, the breakpoints, the motion durations and easings, the reduced-motion table, the focus ring as a 2 px outline with a 2 px offset, and the 44 px touch targets. The corrections are in section 11.

---

## 3. The generative grammar for Meridian

The relationships that produce many screens from few rules:

1. **Identity.** A plan has one selected step at most. Its mark is the only red edge on a step that is not running. It is the same mark in every view. `reduce()` never changes the selection on a view change, a close, or an assistant toggle.
2. **Distance.** A plan can be seen whole (canvas), along its reading order (strip), as an index (list), or one step at a time (details). Switching distance is a segmented control, not a navigation. The reader's place is the selection, so switching keeps it.
3. **Axes.** Horizontal is "reads / read by". Vertical is "runs alongside". A reviewer can say "this step depends on that one" by looking at the arrows, and "these two can run together" by looking at the column.
4. **Visibility of restriction.** A filter that hides steps says so in words, with the count, and offers one reset. A step the reader asks for is never hidden from them.
5. **Words before colour.** Every state carries a word, a shape and a tone. A plan read in greyscale is the same plan.
6. **Money with a reading.** `est. $x` is an estimate. `$x` is recorded. `not recorded` is missing. `No model call` is a fact about the step. Zero is a recorded zero, never a stand-in for a missing value.
7. **Attention.** Red marks now: the selection, a running step, the one primary action, the focus ring, an unread count, the viewport box on a minimap. Nothing else is red.

The logo's red meridian and the selection mark are the same idea: the place you are. The logo is not part of the app's selection logic, but both use the one red so they read as one system.

---

## 4. Surfaces

For each surface: the identity it carries, the distance it offers, what restricts it, its loading geometry, and its phone form. The prototype builds 4.1 to 4.5. 4.6 names the rules for the rest.

### 4.1 Brief (Create, step 1)

- **Identity:** the brief is one object, with a name and a draft that saves itself (Katana section 7).
- **Layout:** the title and one action in the header; a 680 px reading column; example goals as chips that fill the field and nothing else.
- **Disabled and missing:** a control that cannot work shows why in words beside it. Reference files reads "NOT CONNECTED. Connect file storage in Settings to attach files." The NOT CONNECTED row is a row, not a fake control.
- **Assistant:** a column that pushes the reading column when opened. It has `aria-expanded` on its toggle. Its input is disabled with the reason beside it, because the assistant is not connected in this sample.
- **Primary action:** "Plan the run", the only red fill.

### 4.2 Plan, the canvas (Create, step 2)

- **Identity:** the selected step carries the red top mark. Its position does not change when the details panel opens.
- **Distance:** the canvas shows the whole plan; the strip and the list are the other distances (4.3, 4.4).
- **Axes:** columns are dependency depth (`layoutSteps`). Steps in one column stack in plan order. The reading order (column by column, top to bottom) is the Tab order, the strip order and the list order, so the same step comes next in every view.
- **Restriction:** a filter dims the steps it does not show on the canvas, and keeps them where they are. The layout never moves. On the strip and the list those steps are removed, and the count says so.
- **Zoom:** the default is 75%, with steps of 50, 75 and 100%. Katana's "fit to width" is rejected for this canvas: a plan of eight steps is 2,280 px wide, and fitting it to a 1,144 px frame needs 50%, which makes the 11 px label 5.5 px. The frame scrolls both ways instead, as Katana section i already allows.
- **Edges:** 1.5 px, muted by default. A running step's incoming edge is a 2 px red dash that moves; under reduced motion it stands still.
- **Loading:** "Redraw plan" turns every step into a skeleton in the same box, and back. The restriction line and the notice slot reserve their height and width.
- **Resume:** the primary action is disabled while any step needs the person. The reason names those steps in words, and is tied to the button with `aria-describedby`.

### 4.3 Plan, the strip

The same steps, in reading order, as a ribbon of cards with a hairline between each pair. Each card keeps the node's fields in the node's places: kind and state on top, title, model, cost. Only the frame is different. The strip scrolls horizontally inside its own frame.

### 4.4 Plan, the list

An index of the same steps, in the same reading order. Columns on desktop: state, step, kind, model, cost, reads. On a phone the same rows stack: state and cost on the first line, the step title, the model, the reads. The selected row has a 2 px red left mark and the selection fill (`accent-red-muted`).

### 4.5 Step details

- **Identity and place:** a panel that overlays the right 480 px of the window. The step the reader chose is moved clear of it, by scrolling the canvas, never by moving the step.
- **Attached context:** the kind and "step 6 of 8", the state word, the title, the model, the cost, what the step reads (buttons that select those steps), what reads it, and the reason it stopped, in words, with a tone edge.
- **Keyboard:** the title takes focus when the panel opens. Escape closes it and returns focus to the step. The close button says what it closes.
- **Phone:** a bottom sheet, up to 78% of the height.

### 4.6 The other places

- **Home:** the attention list is the same model as the Plan's "needs you" filter, so a step waiting on the person appears in the same words everywhere. Running items show the loading mark (Katana section 3.5), with a label.
- **Library:** a tile opens the same details panel, and returning closes it to the same tile (Onlab's "return anchor").
- **Insights:** each tab keeps its own filter and scroll. A filter that hides a number says so in words, with a reset (visible restriction).
- **Settings:** each connection is a row with its true state in words and one action. A connection that is not connected shows NOT CONNECTED and the next step, never a success.
- **Login and the empty Home:** the logo animates once and rests (Katana section 3.4). Where the screen would otherwise be empty, a real example of the product's state is shown and labelled as an example. Nothing is invented as the user's data.

---

## 5. Typography

- **Scale.** Katana section c, unchanged, with two changes. The display sizes step by container width (below). The state words are sentence case (section 6.5).
- **Titles by container.** `.page-title` is 28 px / 34 px. In a container at least 768 px wide it is 36 px / 40 px. The container is the screen body, so a pushed column makes the title step down. The shipped app uses `@media (min-width: 48rem)` (`src/styles.css`, line 198), so it never does.
- **Measured:** 36 px with the assistant closed, 28 px open, in a 664 px body. Shipped: 36 px both.
- **Trim to cap.** Buttons, the seg control, the places and labels use `text-box: trim-both cap alphabetic` under `@supports`. Measured: supported in the test browser, and the buttons compute to `cap alphabetic`.
- **Labels.** Eyebrows and kind names: 11 px, 600, uppercase, +0.08em. State words: 13 px, 500, sentence case. Only NOT CONNECTED is in capitals, because the engine writes it that way.
- **Figures.** Every number and id is in the mono face with tabular figures. Costs carry their word: `est.`, a bare recorded value, `not recorded`, or `No model call`.
- **Minimum.** 11 px. Inputs are 16 px on phones, so the browser does not zoom on focus.

---

## 6. Colour, surfaces and tokens

### 6.1 The token file

`docs/design/tokens/katana-tokens.json` holds the two themes, the shared scales, and the 35 contrast pairs with their minimums. The Katana plan's 30 pairs are all there. The five added pairs are the state colours on the overlay surface (`info`, `success`, `warning`, `danger`), and `border-strong` on the overlay, because the details panel and the toasts sit on it. The JSON is marked "proposed: not applied to the app" until the owner decides (section 13).

The test that guards it is `src/lib/meridian/a11y/katana-tokens.test.ts`. It checks every pair, the drift against the Katana plan's CSS block, and that every ratio stated in the Katana plan is the computed one. It runs in `npm test`.

### 6.2 The ring on a red fill

The focus ring is a 2 px outline with a 2 px offset, drawn outside the control, so it sits on the page, not on the fill. Katana section j says the ring on a red fill is white. In the light theme that white ring is on a white page:

| Ring colour | On the light page | On the dark page |
|---|---|---|
| white (Katana section j) | 1.00:1, invisible | 21.00:1 |
| `fg-primary` (this plan) | 19.80:1 | 21.00:1 |

The ring is `fg-primary` on red fills. Everywhere else it is `accent-red`, which is 5.88:1 on light and 5.70:1 on dark.

### 6.3 Red

Katana section 3.2 lists the uses of red. This plan adds one: the viewport box on a minimap, which Katana principle 1 already allows. The rest of the list is unchanged. A review fails a screen that has two red fills, or a red element outside the list.

### 6.4 Kind colours

The shipped app colours each kind (`orchestrator-presentation.ts` lines 31 to 40: info, success, warning, accent and muted). In the shipped prototype view, the kind label takes that colour, and it competes with the state dot. The proposal removes the kind colours. A kind is a label and an icon. Colour carries state only.

### 6.5 State words

The ten states, with a dot shape and a tone each (the prototype's `STATE` table, which the test checks against the app's words):

| Word | Dot | Tone | Reason line |
|---|---|---|---|
| Planned | hollow | muted | no |
| Running | filled | accent (red) | no |
| Done | filled | success | no |
| Reused | hollow | success | no |
| Skipped | hollow | muted | yes |
| Failed | cross | danger | yes |
| NOT CONNECTED | plug (square) | warning | yes |
| Paused at budget | pause | warning | yes |
| Queued at the provider | hollow | info | yes |
| To re-run | dashed | secondary | no |

"Queued at the provider" is the state Katana section h omits. The sentence-case words follow the app. Katana's uppercase state words are rejected.

### 6.6 Surfaces and shadows

Katana section d says no shadows. The shipped app has two: the inset attention signal (`src/styles.css` line 284, `.attention-signal`), which becomes a 2 px mark, and a light-theme overlay shadow (`:root[data-theme="light"] .surface-overlay`), which becomes a strong edge. `.signal-ring` (line 285) is a 2 px box-shadow ring, which becomes a border. `.surface-glow` (line 245) is a noise texture behind a panel. It is decoration, so it goes.

### 6.7 Dark and light

The prototype follows the system setting when no theme is chosen, and an explicit Dark or Light choice overrides it (measured). The bare root is the dark palette; the light palette is the same structure inverted: a white room, ink text, the light red `#C8102E` (5.88:1 on white). The two reds are one role. Katana's open question 1 (dark for everyone, or follow the system) is still the owner's. Until it is answered, the prototype follows the system.

---

## 7. Layout, breakpoints and recomposition

### 7.1 Breakpoints

Katana section i, unchanged: 640, 768, 1024 and 1280 px. The title tier is the one exception, because it follows the container.

### 7.2 Widths and the shell

- Work screens: 1,200 px maximum. Reading and forms: 680 px.
- The rail: 232 px (64 px collapsed). On a phone it is a five-item bottom bar, 56 px high with the safe-area inset, and the screen has 72 px of bottom padding so the bar never covers its content.
- The page never scrolls sideways. Only a canvas, a strip or a table scrolls, inside its own frame (Katana section i).

### 7.3 Phones

The canvas is not shown on a phone. Its place is the list, which is the same steps in the same reading order, with the state and the cost on the first line. The Strip segment remains for a reader who wants the ribbon. The details panel is a bottom sheet.

This replaces Katana section i's "the frame scrolls both ways". A seven-column canvas scrolled on a 390 px screen is the "unusably small copy" that Onlab names as the failure of responsive recomposition (PDF page 31). The owner decides this (section 13).

### 7.4 Push and overlay

| Surface | Behaviour | Reason |
|---|---|---|
| Assistant | Pushes the reading column | Its text is read beside the brief. Measured: the body narrows to 664 px. |
| Step details | Overlays the right 480 px | The plan is spatial. Moving it under the reader breaks identity. Measured: the step's layout position is unchanged, and the step is kept clear of the overlay. |
| Toasts | Overlay the bottom-right corner | Nothing is pushed by a notice. |

---

## 8. Motion

### 8.1 What moves

Katana section e, kept: fades of 120 to 200 ms on layers and steps, a 4 px rise on a step appearing, an edge that draws in over 200 ms, the drawer's 16 px slide with its fade, the running edge's dash, and the logo.

### 8.2 What stops

- The running dot's pulse (`.signal-working`, `signal-pulse`, `styles.css` line 286). Katana section e already forbids it ("no pulse, ever"), so this is a shipped divergence to remove, not a Katana error.
- The scale in the orchestrator's step entrance (`.orch-node`, `orch-pop`, `styles.css` line 275). Katana forbids scale.
- The surface noise texture (`.surface-glow`, line 245).

### 8.3 Reduced motion

The global rule in `src/styles.css` (line 332) stays. It stops every movement and keeps colour and opacity fades at 120 ms. The prototype's rule is the same. The capture checks that no infinite animation is running under reduced motion (measured: 0). Sanity's partial rule is not adopted.

### 8.4 Time

A confirmation (success, info) leaves after 4 s. A warning or failure stays until closed. Hovering a toast pauses its timer, and leaving restarts it. This is the one place the design uses time to say what matters.

---

## 9. Components and states

Katana section h is the table; this section records what changes.

- **Buttons.** Four variants, as Katana section 8. The primary is the one red fill on a screen (Katana section 14.7). White is kept for switches, checkboxes and progress. Heights: 40 px, 44 px on touch.
- **Disabled.** A disabled control has its reason in words beside it, tied with `aria-describedby`. The Resume action on the Plan screen does this, and names the steps.
- **Disclosures.** Every disclosure exposes `aria-expanded`. The assistant toggle does (measured in the prototype). Sanity's mega-menus do not (ENTRY.md §13), and Meridian's brand switcher and account menu must.
- **Tabs.** Where an app uses tabs: `role="tablist"`, `aria-selected`, roving `tabindex`, arrow keys move between them, and the selected tab has a 2 px red underline. The prototype has none; it is one scrolling page of plates, with a contents rail.
- **Segmented controls.** `aria-pressed` on each view and filter button. The current one has a 2 px red base.
- **Step cards and rows.** Section 4.2 to 4.4. The selected card has a 2 px red top mark (canvas and strip) or left mark (list).
- **Notices.** Section 8.4. The toast's status bar is 2 px on the left, in the tone.
- **Inputs.** A 1 px strong border on the page. Labels above, in secondary text. Errors below the field, with `aria-invalid`.

---

## 10. Accessibility and keyboard

- **Order.** Tab walks the steps in reading order: column by column, top to bottom (measured: 8 of 8). The skip link is the first stop (Sanity's fourth-stop finding).
- **Enter** opens a step's details. **Escape** closes them and returns focus to the step (measured).
- **Arrow keys** scroll the canvas when it has focus. `+` and `−` zoom it, and `0` resets the zoom to 75%. Fit-to-width is not used (section 4.2).
- **Shortcuts.** The Keyboard plate lists the keys. The `?` sheet and Ctrl or Cmd + K (command palette) are in Katana section j and are not built in the prototype.
- **Colour off.** Every state reads in greyscale (measured: ten distinct words).
- **Contrast.** 35 pairs, in both themes, against the repo's helper (section 6.1).
- **Focus.** A 2 px outline with a 2 px offset in accent red, or `fg-primary` on a red fill (section 6.2). It is never removed.
- **Motion.** Section 8.3.
- **Names.** A step's accessible name is its kind, title, state, model and cost, in that order, with the cost read as "estimated" or "recorded" (Katana section j). The prototype builds it from the model.
- **Not tested:** screen readers, touch hardware, and the WCAG pass in a full audit.

---

## 11. Corrections to the Katana plan

| # | Katana plan says | What is true | Where it is corrected |
|---|---|---|---|
| 1 | Section e: "The current global rule in `src/styles.css` cuts every transition to 0.01 ms." | The shipped rule keeps colour and opacity fades at 120 ms (`src/styles.css` line 332). | Section 8.3 |
| 2 | Section j: the ring on a red fill is white. | 1.00:1 on the light page. | Section 6.2 |
| 3 | Section h: state words are uppercase (PLANNED, RUNNING). | The app's words are sentence case, and the shipped system rejects all-caps labels. NOT CONNECTED stays capitalised. | Section 6.5 |
| 4 | Section h: ten states, with no "Queued at the provider". | The app has it (`orchestrator-presentation.ts:60`). | Section 6.5 |
| 5 | Section h: the primary button is white. | Section 14.7 makes primary buttons red. Section h's table is stale. | Section 9 |
| 6 | Section i: on phones the frame scrolls both ways. | Recomposed as the list (Onlab, PDF page 31). Owner decision. | Section 7.3 |
| 7 | Section c: display-l is 36 / 40 from 768 px, by window. | By container, so a pushed column steps it down. | Section 5 |
| 8 | Section l: `katana-tokens.json` is generated from the plan. | The file did not exist. It now does, and a test keeps it equal to section l's CSS. | Section 6.1 |
| 9 | Section i: the fit-to-width canvas is the default. | At eight steps it makes the 11 px label 5.5 px. Default 75%. | Section 4.2 |

Confirmed, not corrected: Katana section b's thirty contrast pairs, and the ratios it states for them, are right. The test computes all sixty stated ratios with the repo's helper, and they match.

---

## 12. Migration

This plan adds steps to Katana's M0 to M6 (section m). It does not replace them. Each step is one branch and one PR, with before and after screenshots (`AGENTS.md` rule 10). Nothing starts until the owner decides section 13, item 1.

- **MX1. Tokens.** Add `katana-tokens.json` to the app's token path, next to the AttentionOS file. Extend `src/styles.contrast.test.ts` to read it (Katana M1 and M2). No visual change.
- **MX2. Title tiers.** `.page-title` by container (`@container`). The screen body becomes the container in `src/components/shell.tsx` and `src/components/workspace.tsx`. Test: the title tier at two widths, with and without a pushed column.
- **MX3. The state map.** `orchestrator-presentation.ts`: add "Queued at the provider" in its info tone, drop the kind accents, make state words sentence case. `orchestrator-presentation.test.ts` is rewritten for the new map (Katana M4 already says so). The prototype's model test pattern (words equal the app's) is copied for it.
- **MX4. The canvas.** Default zoom 75%. Phone list recomposition in `orchestrator-canvas.tsx`. The `layout.ts` constants stay. Test: the phone list keeps the reading order.
- **MX5. Details panel and assistant.** Overlay for the details, push for the assistant, in `orchestrator-screen.tsx`. Test: a selected step's layout position is unchanged when the panel opens.
- **MX6. Motion and shadow.** Remove `.signal-working`, `.signal-ring`, `.surface-glow`, `orch-pop`, `.attention-signal`'s inset shadow and the light overlay shadow. Test: no `box-shadow` with a blur in `src/**/*.tsx` or the stylesheet, and no infinite animation under reduced motion.
- **MX7. Focus and disclosures.** The focus ring on red fills (`fg-primary`). `aria-expanded` on every disclosure in `shell.tsx`, the brand switcher and the account menu. Test: a Playwright pass on the keyboard path.

Each phase keeps the existing gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

---

## 13. Decisions for the owner

1. **The canonical system.** The owner's Katana decisions (red accent, black room, 2 px) are the base, but the app still runs AttentionOS violet. Should migration MX1 onwards start, or should the app stay on AttentionOS and take only the mechanisms (MX2 to MX7 work on either base)?
2. **Phones.** The canvas is replaced by the list, not scrolled. (Overrides Katana section i.)
3. **Canvas zoom.** Default 75%, not fit-to-width. (Overrides Katana section i.)
4. **Push and overlay.** Overlay for spatial screens (the details panel), push for reading screens (the assistant). Confirm.
5. **State words.** Sentence case, with NOT CONNECTED in capitals. (Overrides Katana section h.)
6. **Focus ring on red fills.** `fg-primary`, not white. (Corrects Katana section j.)
7. **Queued at the provider.** Added to the state set, with the info tone and a hollow dot.
8. **Progressive wide-gamut colour.** Rejected (section 2.2). Confirm, or name the contrast check that would make it acceptable.
9. **Sample content.** The prototype uses a sample plan, sample costs and sample models, labelled as samples. Confirm that is the right level for a design review. No live data was used.

---

## 14. Verification

Run in this session, in the working tree (the work is not yet committed; see the note at the end of this section):

- `src/lib/meridian/a11y/katana-tokens.test.ts`: 5 tests, pass.
- `scripts/design-prototype-model.test.mjs`: 20 tests, pass. It sits in `scripts/`, which `npm test` and the CI shards already run.
- `docs/design/prototype/capture.mjs`: 28 measured claims, all hold, with screenshots in `docs/design/prototype/screens/`. Results in `screens/measurements.json`.
- `npx eslint` on the changed files: 0 errors, 0 warnings.
- `npm run typecheck`: exit 0.

Not run: the full `npm test`, the full `npm run build`, and the lint across the repo. The prototype is not part of the app build, and its files are outside the app's source tree.

The commit is held. The designated branch `claude/nice-tesla-zrf6un` is already merged into `main`, so this work needs the branch restarted from `main` before it can be committed and pushed. That reset was blocked by the permission check in this session, and it awaits the owner's go-ahead.

---

## 15. Limits

- Samples only. Costs, models and states are placeholders.
- Chromium only. The trim rule is progressive.
- No screen reader, no hardware, no Safari or Firefox pass.
- The canvas's CLS was measured on one redraw in one browser.
- Sanity's raw assets are not in the repo, so its figures can be checked only against `sources.json` hashes. The raw files are the site's, and the hashes identify the version studied.
- The Onlab study is one reference. Its principles are structural. Its visual choices are not adopted.

---

## 16. The showcase as plates

The prototype is a set of small plates, not a set of screens. Each plate is one part of the design, and carries three things: what it does, what it means for the work, and a specimen that shows it. A reader can take in one plate at a time.

**Plate anatomy.** An index number and a label, then a title in the display face, then two rows: **Does** (the behaviour, in one or two sentences) and **Means** (the consequence for a person doing the work). A specimen follows, and a footnote gives the measured result where there is one. Plates sit on a twelve-column grid, at spans of 12, 7, 6 or 5. Where a plate is taller than its neighbour, it keeps its own height.

**Spacing.** A 4 px base. Chapters have 96 px above them. Plates are 24 px apart, with 32 px inside (22 px on a phone). The page is 1,280 px at most, with a 200 px contents rail on the left at desktop widths. A phone has one column and 20 px either side.

**Type.** Archivo sets every title, in weight 600 with a width of 92%, so headings read as engineered rather than soft. The masthead title steps by its container, 56, 80 and 104 px. Plate titles are 28 px. Instrument Sans sets the text. JetBrains Mono sets every label, index number and figure, so digits line up. Labels are small, uppercase and tracked at 0.12em (sentence case in the shipped look, which does not use them).

**Texture.** Three textures, each with no meaning of its own, and none of them lowering a contrast:
- a faint twelve-column guide behind the page (3 to 4% of the ink colour), so the grid can be felt;
- a dot field on each specimen and on the globe mark (10% of the ink colour in the proposal), so a specimen reads as a board, not a blank box;
- a grain layer on each plate (4 to 5% opacity), which gives the surface a printed quality.

The globe mark is the logo's motion source, drawn from `docs/design/logo/`. Its red meridian turns slowly. It is the only ambient motion on the page, and reduced motion stops it.

**One selection, many plates.** A step chosen in any plate is chosen in every plate. The thread belongs to the plan, so the page is read as one object, not as separate demonstrations.

**Limits of the showcase.** Every number on the page is a sample. The measured results in the footnotes come from the capture, and the capture is the only place a claim is checked. Textures and grain are decoration by the rule above, and any change to them must keep every text contrast in section 6.

## 17. The full web design

The walkthrough is `docs/design/prototype/presentation.html`. It draws the whole web app in the proposal, one screen at a time: fourteen screens and a cover. Each screen comes with what it does, what it means for the person, and what was checked on it. It is a proposal. Nothing under `src/` changed, and no screen is built here.

**The screens.**

| Group | Screen | What it shows |
|---|---|---|
| Start | Sign in | One field and one red action. The copy says what the address is for. |
| Start | First run, step 2 | Three steps with a progress bar. The workspace name is the only input. |
| Home | Today | What needs the person, one row each with its state word and one action. Then what is running, then three figures. |
| Home | Today, with nothing to do | The empty state names what will appear and gives the one way to start. |
| Create | Brief | The brief, examples, the settings that apply, and reference files, which say NOT CONNECTED when they are not. |
| Create | Plan | The step bar and the plan, in Strip and List views with filters. It is the same component as the plan in the plates. |
| Create | Plan that could not be drawn | A failed plan says so, keeps the brief, and gives the request id. |
| Create | Review | Four gates with their words, a preview that says nothing was made, recorded and estimated costs, and Approve disabled until Rights is cleared. |
| Library | Library | Tiles, filters, and the details of the selected item. A tile with no preview says so. |
| Insights | Insights, market | One chart, its source line, and a plain note on what it means. |
| Settings | Connections | Each connection with its true state: connected, error, or NOT CONNECTED. |
| Settings | Connect Google Ads | The three-step connection. The middle step says it leaves Meridian and publishes nothing. |
| Settings | System | Recent jobs in a table. Ids are in full, and a duration that was not recorded says so. |
| Overlay | Command palette | Opens over any screen, groups results by where they go, and shows each key. |

**Principles the capture checks.** These are measured in the browser, so they are claims, not intentions:

- At most one red fill per screen, counted from the colour drawn. Red marks the one thing that starts or commits the screen's work. Review has none, because its only action is blocked.
- Every disabled control has a sentence beside it that says why, linked to the control for a screen reader.
- Numbers say what they are: recorded, estimated, or not recorded. A missing value shows as missing, never as zero.
- Sample data is labelled, and no screen shows a success that did not happen.
- Colour is never the only signal. Each state has a word and a dot.
- No sideways scroll at 1440 or 390 px.

**The one red action.** Red fill appears on the action that starts or commits the screen: Sign in, Create, Plan it, Continue to Google, Open in review, Continue in first run. A disabled action is never red. The palette's selected row has a red edge, not a red fill.

**The phone frame.** A frame narrower than 640 px takes the phone layout. The five places become a bottom bar, content stacks into one column, rows wrap, and the steps stack. The walkthrough can show any screen at 390 px, and a window at phone width gets the same layout. On a phone the plan is a list, not a canvas. That is an owner decision (section 13).

**Verification.** `capture-presentation.mjs` checks nine claims in headless Chromium: every screen renders and is indexed; at most one red action; every disabled control says why; no sideways scroll at 1440 and 390; the phone layout; the arrow keys and the ends; and a step chosen on the plan screen opens its details. All nine hold. The single-file build of the walkthrough was also loaded in Chromium: 15 positions, the phone frame at 390 px, no sideways scroll, and no console errors.

**Not verified.** Chromium only. The data is sample data. There is no screen reader pass and no real device. The Home, Library, Insights and Settings screens are proposals. Their copy is not checked against the app's routes or strings; the model tests check the plan's copy and nothing else. The owner decisions in section 13 apply to these screens too.

## Appendix A. Files

| File | What it is |
|---|---|
| `docs/design/MERIDIAN_MIXED_DESIGN_PLAN.md` | This plan |
| `docs/design/tokens/katana-tokens.json` | Proposed tokens, 35 contrast pairs |
| `src/lib/meridian/a11y/katana-tokens.test.ts` | Checks the tokens, the drift from the Katana plan, and its stated ratios |
| `docs/design/prototype/index.html`, `prototype.css`, `app.mjs`, `mount.mjs` | The page of plates, its styles, its controller, and the plan component that is mounted in the plates |
| `docs/design/prototype/model.mjs` | The pure model |
| `scripts/design-prototype-model.test.mjs` | Its tests (in `scripts/`, so CI runs them) |
| `docs/design/prototype/capture.mjs` | Browser capture and the 28 measured claims |
| `docs/design/prototype/build-artifact.mjs` | Builds a single-file page for publishing (styles and scripts inlined): `index` (the plates) or `presentation` (the walkthrough) |
| `docs/design/prototype/screens/` | Screenshots of the plates and `measurements.json` |
| `docs/design/prototype/presentation.html`, `presentation.css`, `presentation.mjs` | The walkthrough of the full web design: the index, the stage, the frame width and the keys |
| `docs/design/prototype/screens.mjs` | The fourteen screens and the cover: their markup, copy and notes |
| `docs/design/prototype/capture-presentation.mjs` | Browser checks for the walkthrough (9 claims) and its screenshots |
| `docs/design/prototype/presentation-screens/` | One screenshot per screen, four phone frames, and `presentation-measurements.json` |
| `docs/design/prototype/README.md` | How to open, test, capture and publish |
| `docs/design/research/sanity/` | The Sanity deep entry and its JSON evidence |
