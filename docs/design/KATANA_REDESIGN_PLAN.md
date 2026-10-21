# Katana: the Meridian redesign plan

The final design brief and build plan for the full Meridian web redesign. It is written to be handed to build agents as it stands.

- **Design language reference:** `docs/design/KATANA_DESIGN_PLAN.md`. It holds the exact colour values with their contrast checks, the type scale, the component states and the token file. This document does not repeat those values. Where the two disagree, this document wins on structure and flow, and the design plan wins on token values.
- **Logo:** `docs/design/logo/` (the motion source, the hero still, the GIF and the MP4).
- **Repository rules:** `AGENTS.md` and `CLAUDE.md`. They apply to every task here.

---

## 1. The essence

A katana is one piece of steel and one purpose. Everything that does not serve the cut is taken away, and what is left is exact.

Meridian should feel the same way. It is a black room with white type, and red marks the one thing that matters on the screen right now. Each screen has one job and one main action. Nothing is decoration, and every line is there because it carries meaning.

**Three words for every review: sharp, quiet, certain.**

- **Sharp:** 2 px corners, hairline edges, exact alignment, a tight type scale. Nothing is soft or blurry.
- **Quiet:** black space does the work. A screen shows a few things at a time. Red appears only where attention belongs.
- **Certain:** every state is named in words, every number says what it is, and nothing pretends.

---

## 2. Experience rules

Each rule has a test a reviewer can run on a screenshot.

1. **One screen, one job, one primary action.** Test: a screen has at most one filled red button. Everything else is a quiet button, a link, or sits in a menu.
2. **Three things above the fold.** Test: at 1280 x 800 the first view holds the page title, one summary, and the single most useful next thing, such as a list, a composer or a canvas. Anything else is below or one click away.
3. **Five places, no more.** Test: the main navigation has five entries (section 4). Everything else is reached from inside those places or from the command palette (Cmd/Ctrl+K).
4. **Show less, reveal on intent.** Test: advanced settings, raw ids, logs and audit detail sit behind a "Details" disclosure, a drawer or a tab. They are never shown by default.
5. **Say what is missing, in words, where the work happens.** Test: every disabled control, empty state and NOT CONNECTED state names what is missing and the next step, in visible text. Disabled buttons are never silent. (Repository rule: not-connected stays visible and is never faked.)
6. **Short copy.** Test: a page subtitle is one sentence of 14 words or fewer. A button is a verb and at most three words. An empty state is two short sentences and one action.
7. **Every number says what it is.** Test: costs and metrics use the mono face with tabular figures. An estimate starts with "est.". A value with no source reads "not recorded", never 0 and never blank.
8. **Motion explains a change.** Test: every UI animation is under 240 ms and explains a state change (opening, selecting, loading). The logo is the only ambient motion. With reduced motion turned on, nothing in the UI moves.
9. **The keyboard always works.** Test: every action can be reached with Tab and Enter. The focus ring is a visible 2 px red. Cmd/Ctrl+K opens the palette from anywhere.
10. **Phones get the same product.** Test: at 390 px no page scrolls sideways, touch targets are at least 44 px, and the five places are in a bottom bar.

---

## 3. The look

All values are in `KATANA_DESIGN_PLAN.md` sections b to e and l. Here they are in brief:

| | Decision |
|---|---|
| Room | `bg-base` pure black #000000. Raised surfaces #0E0E0E. Overlays #161616. |
| Ink | White #FFFFFF for primary text. Secondary and muted greys from the token file. |
| Red | `accent-red` #FF2E38 (5.70:1 on black). It is used only for the focus ring, the current navigation item, a selected item, a running step, an unread count and the one primary action. |
| Type | Archivo for display, Instrument Sans for text, JetBrains Mono for numbers, ids and costs. The minimum size is 11 px. |
| Shape | A 2 px radius everywhere. Round shapes only for dots, avatars, radios, switch thumbs and the logo. |
| Edges | 1 px hairlines. No shadows anywhere. A floating layer is an overlay surface with a 1 px strong edge. |
| Space | One 4 px scale. Generous outer space, tight inner rhythm. |
| Light theme | A counterpart exists in the token file. Dark is the product; light is secondary (open question 1). |

**Signature details**, used sparingly so they stay special:
- **The red edge:** a 2 px red mark on the left of a selected row, card or step. It is the Katana "cut".
- **The loading ring:** the logo's meridian loading ring is the app's only loading indicator. It is a thin red ring with a comet head, 16, 24 or 48 px. There are no other spinners.
- **The mark:** the 3D globe appears in exactly three places: the login screen (animated), the empty home of a new workspace (animated once, then still), and the top-left of the shell (a still at 24 px).

---

## 4. Information architecture: five places

Today the app has about 30 routes and a long side menu. The redesign groups them into five places. No route is deleted: each old URL redirects to its new home, so links keep working.

| Place | Its one job | What moves in (current routes) |
|---|---|---|
| **Home** | What needs you now, and what is running. | `/` (workspace overview), `/notifications`, `/alerts`, `/brands/$brandId` (brand overview, as the brand view of Home) |
| **Create** | Make a video or an ad, from brief to delivery. | `/content-factory`, `/orchestrator`, `/brands/$brandId/studio`, `/brands/$brandId/factory` |
| **Library** | Everything made or kept. | `/brands/$brandId/library`, `/brands/$brandId/pages`, `/brands/$brandId/products`, `/exports` |
| **Insights** | What the market and our results say. | `/brands/$brandId/market`, `/brands/$brandId/opportunities`, `/brands/$brandId/intelligence`, `/brands/$brandId/learning`, `/brands/$brandId/reviews`, `/brands/$brandId/calibration`, `/brands/$brandId/brain` |
| **Settings** | Connect, configure, check the system. | `/settings`, `/integrations`, `/brands/$brandId/accounts`, `/usage`, `/invite`, `/setup`, plus a **System** tab for `/jobs`, `/audit` and `/webhooks` |

- **The brand** is chosen once, in the brand switcher at the top of the side rail. Every place then shows that brand. `/brands/new` becomes "New brand" in the switcher.
- **The command palette** (`src/components/command-palette.tsx`) reaches every screen and action by name. It is how power users skip the navigation.
- **Inside a place,** a secondary level appears as tabs at the top of the page, never as more side-menu items.

The grouping is a proposal for the owner to confirm (open question 2). The build plan puts it behind the routing work in phase 2, so a change of grouping does not touch the screens.

---

## 5. The shell

```
┌────────┬──────────────────────────────────────────────────────────┐
│ ◉ Brand ▾│  Page title                              ⌘K   🔔   ◐ │
│        │  One-sentence purpose.                    [ Primary ]   │
│ Home   │ ─────────────────────────────────────────────────────── │
│ Create │                                                          │
│ Library│        the one thing this page is for                    │
│Insights│                                                          │
│Settings│                                                          │
│        │                                                          │
│ ◉ you  │                                                          │
└────────┴──────────────────────────────────────────────────────────┘
```

- **Side rail:** 232 px wide, collapsible to 64 px (icons only, with tooltips). It holds the mark and brand switcher at the top, the five places, and the account at the bottom. The current place has a red 2 px left edge and white text. The others are muted. The rail has no section headings.
- **Top bar:** none. The page header carries the title, one sentence and the primary action. The palette trigger (⌘K), notifications and the theme toggle sit at the right of the header row, as quiet icon buttons.
- **Content:** a max width of 1200 px for working screens and 680 px for reading and forms. The side gutter is 32 px on desktop and 16 px on phones.
- **Phones:** the rail becomes a five-item bottom bar (icons and labels at 11 px). The brand switcher moves into the header.
- **Code:** `src/components/shell.tsx`, `src/components/workspace.tsx`, `src/components/command-palette.tsx`, `src/components/ui/layout.tsx`.

---

## 6. The screens

Each screen gets a title, one sentence, one primary action, and its one main surface. This section gives the shape. Details belong to the build agent, within these rules.

### 6.1 Login and first run
- A centred column on black. The animated mark sits at 160 px, with the wordmark "Meridian" in Archivo below it, then the sign-in form. That is all.
- First run, with no workspace yet: one field, "Name your workspace", and one red button. The second step is "Add a brand": a name and a website. Everything else waits until later.
- Code: `src/routes/login.tsx`, `src/components/home/create-workspace.tsx`, `src/components/setup/`.

### 6.2 Home
- **Title:** "Today". **Sentence:** what needs you and what is running.
- **Main surface:** one list, "Needs you", of attention items (approvals, failed or paused runs, NOT CONNECTED accounts), each with one action. Below it is a quiet "Running now" strip, with the loading ring on each running item.
- **The KPI row** shrinks to three numbers at most, in the mono face, each labelled with its source. Anything else goes to Insights.
- **Empty:** the mark (animated once), then "Nothing needs you." and one action: "Create".
- Code: `src/components/home/`, `src/routes/_app/index.tsx`.

### 6.3 Create (the flagship)
One flow in three steps, with a thin step bar at the top: **Brief, Plan, Review**.
1. **Brief (the composer):** one large text box for the goal, with three example goals as chips beneath it. Below the box is one row of quiet chips: brand, format, budget and model (the model is the stored orchestrator model, read-only, with a link to change it). Inputs that cannot be attached yet are shown as NOT CONNECTED rows, never as fake controls. One red button: "Plan it".
2. **Plan (the canvas):** the orchestrator canvas fills the screen on black. Steps appear as they are planned and are joined by hairline edges. A step card shows its kind icon, title, model id (mono), state and cost. The selected step gets a red top edge. A floating toolbar holds zoom, fit and the run state. A right drawer opens on a step, to change it and see what would re-run. One red button: "Run".
3. **Review:** the result, a player or still, with its cost, the gates (originality, claims, policy, rights) as plain pass, review or blocked rows, and one red button: "Approve" (shown only to roles that may approve).
- The chat panel from Content Factory becomes a collapsible right drawer in Brief, not a second column.
- Code: `src/components/content-factory/`, `src/components/studio/`, `src/components/factory/`, `src/routes/_app/content-factory.tsx`, `src/routes/_app/orchestrator.tsx`.

### 6.4 Library
- A grid of thumbnails with a filter row of at most three filters (type, status, date) and search. A row or tile opens a right drawer with details and one action.
- Code: `src/components/library/`, `src/components/publishing/`.

### 6.5 Insights
- Tabs: **Market, Opportunities, Results, Learning**. Each tab is a lead chart or list and a short "what this means" line. Calibration and the Brain live under Learning, behind "Details".
- Charts are hairline charts in white and grey, with one red series for the current focus. Every metric is labelled with its source, and a figure with no source reads "not recorded".
- Code: `src/components/market/`, `src/components/opportunities/`, `src/components/learning/`, `src/components/reviews/`, `src/components/brain/`, `src/components/research/`.

### 6.6 Settings
- Tabs: **Workspace, Brands, Connections, Team, Usage, System**. Each tab is a single column at 680 px. Each connection is a row showing its state (Connected, NOT CONNECTED, or Error with the reason) and one action. The System tab holds jobs, health, audit and webhooks, as dense tables with mono ids.
- Code: `src/components/settings/`, `src/components/accounts/`, `src/components/ops/`, `src/components/provider-settings-panel.tsx`.

---

## 7. Components

Restyle the existing primitives in `src/components/ui/`. Do not fork them. Each one follows section h of the design plan for its states.

| Primitive | Katana treatment |
|---|---|
| Button (`button.tsx`) | Four variants only: **primary** (filled red, white text, at most one per screen), **secondary** (1 px white border), **quiet** (text only), **danger** (red text, red border). Height 36 px on desktop and 44 px on coarse pointers. |
| Field, input, select (`field.tsx`, `controls.tsx`) | A 1 px strong border on `bg-raised`, with the label above at 13 px. Focus is a 2 px red ring. The error text is below the field, in words. |
| Card (`card.tsx`) | `bg-raised` with a 1 px hairline. No shadow. Selected: a 2 px red left edge. |
| Table (`data-table.tsx`) | Header in label style (11 px uppercase), rows divided by hairlines, ids and costs in mono. A selected row gets the red edge. |
| Badge and status (`badge.tsx`, `status-map.ts`) | Text with a dot. Colour is never the only signal. NOT CONNECTED is always written out in full. |
| Feedback (`feedback.tsx`) | Toasts sit bottom-right on an overlay surface with a hairline. Empty states are two sentences and one action. Loading uses the meridian loading ring. |
| Layout (`layout.tsx`) | The page header (title, sentence, actions), tabs, and the right drawer. |
| Theme (`theme.tsx`) | Dark by default, with a light toggle. |

New primitives, only these: **Drawer** (right side, 480 px, Esc to close), **Tabs**, **StepBar**, **LoadingRing**, and **Mark** (the logo: a still SVG or PNG, plus the animated canvas for login and empty home).

---

## 8. Motion

- **Durations:** 120 ms for hover and press, 180 ms for open and close, 240 ms for a page-level change. One easing curve: cubic-bezier(0.2, 0, 0, 1).
- **What moves:** drawers slide 16 px and fade, a selected item's red edge draws in, the loading ring turns, and canvas steps appear as they are planned.
- **What never moves:** layout, text, numbers and anything decorative.
- **Reduced motion:** every UI animation stops. The loading ring becomes a static ring with a "Loading" label, and the logo shows its still frame.

---

## 9. Voice

- Plain, short, active verbs. "Plan it", "Run", "Approve", "Connect".
- No hype, no exclamation marks, no emoji.
- Say what is missing and what to do: "Meta is not connected. Connect it to publish."
- Name things the way the user does: "videos", "brands", "results", not internal job or table names.

---

## 10. Quality bar (definition of done for any screen)

A screen is done when all of these hold:

1. It follows the experience rules in section 2 (a reviewer runs the tests).
2. It uses tokens only, with no literal colours in components. `src/components/ui/tokens.test.ts` passes, extended for the new tokens.
3. Before and after screenshots exist at 1280 px and 390 px, in dark (and light if the owner keeps it). The PR includes them (`AGENTS.md` rule 10).
4. There are no console errors, and no sideways scroll at 390 px.
5. Keyboard: every action is reachable, and the focus ring is visible.
6. Contrast: text pairs meet the ratios in the design plan, section b.
7. Repository rules hold: role checks stay on every mutation control (`hasRole`), tenancy checks stay in server functions, nothing is faked, NOT CONNECTED stays visible, and there is no `dangerouslySetInnerHTML` with untrusted text.
8. Gates pass: `npm test && npm run typecheck && npm run lint && npm run build`.

---

## 11. The build plan for agents

### Ground rules for every agent
- Work only in the files your task names. Do not change server functions, engine code (`src/engine/`), migrations or contracts. The redesign is presentation and routing.
- Do not invent data, metrics or connected states. If a screen has nothing real to show, design its empty or NOT CONNECTED state instead.
- New npm packages need the lead's approval. The fonts are the one planned addition: `@fontsource-variable/archivo`, `@fontsource-variable/instrument-sans` and `@fontsource/jetbrains-mono` (install with `--ignore-scripts`). Inter and Fraunces are removed in the same task.
- Use one branch and one PR per phase. Commit with a clear message. Do not push to `main`.
- Each agent reports in at most 150 words: the files changed, the gates run, the screenshot paths, and anything not verified.

### Phases

Each phase has an exit gate. A phase starts only after the previous gate passes.

| Phase | Work | Owner (one agent per row) | Files | Exit gate |
|---|---|---|---|---|
| **0. Foundations** | Tokens from design plan section l into `src/styles.css` (dark default, light counterpart); the font swap; token test updates | Foundations agent | `src/styles.css`, `src/components/ui/theme.tsx`, `src/components/ui/tokens.test.ts`, `package.json` | All gates green; screenshots of 3 existing screens in the new palette with nothing broken |
| **1. Primitives** | Restyle every `ui/` primitive (section 7); add Drawer, Tabs, StepBar, LoadingRing, Mark | Primitives agent | `src/components/ui/*`, `src/components/brand-mark.tsx` | A `/_design` gallery route (exists as `src/routes/[_design].tsx`) shows every primitive in every state, dark and light, at 1280 and 390 |
| **2. Shell and places** | The five-place rail, the brand switcher, the page header, the phone bottom bar, the palette, redirects from old routes | Shell agent | `src/components/shell.tsx`, `workspace.tsx`, `command-palette.tsx`, `page-commands.tsx`, `src/routes/_app.tsx`, route files (redirects only) | Every old URL lands on its new home; the keyboard works through the shell; no screen content has changed yet |
| **3a. Create** | Brief, Plan and Review (section 6.3), using the existing composer and canvas | Create agent | `src/components/content-factory/`, `studio/`, `factory/`, Create route files | A brief goes to a plan to a review against recorded fixtures; NOT CONNECTED shown honestly without a key |
| **3b. Home** | Today (section 6.2) | Home agent | `src/components/home/`, `src/routes/_app/index.tsx` | Needs-you list, running strip and empty state all reachable with seeded and empty data |
| **3c. Library** | Section 6.4 | Library agent | `src/components/library/`, `publishing/` | Grid, filter, drawer |
| **3d. Insights** | Section 6.5 | Insights agent | `src/components/market/`, `opportunities/`, `learning/`, `reviews/`, `brain/`, `research/` | Four tabs, each with its lead view and source labels |
| **3e. Settings** | Section 6.6 | Settings agent | `src/components/settings/`, `accounts/`, `ops/`, `provider-settings-panel.tsx` | Six tabs; every connection shows its true state |
| **3f. Login and first run** | Section 6.1, with the animated mark | Entry agent | `src/routes/login.tsx`, `src/components/setup/`, `home/create-workspace.tsx` | A new user goes from sign-in to workspace to first brand in 3 screens |
| **4. Polish** | A cross-screen consistency pass: the section 2 tests on every screen, motion and reduced motion, copy, contrast, phones | Review agent (read-mostly; fixes only small issues and reports the rest) | All of the above | A screenshot set of every place at 1280 and 390; a checklist with every row passed or explained |

Phases 3a to 3f run in parallel, because their files do not overlap. The lead merges one at a time and runs the gates after each merge.

### Brief template for each agent

> You are building **[phase and place]** of the Meridian Katana redesign. Read `docs/design/KATANA_REDESIGN_PLAN.md` (this plan: sections 1, 2, 3 and **[your section]**) and `docs/design/KATANA_DESIGN_PLAN.md` (tokens and component states). Work only in: **[files]**. Keep every server function call, role check and NOT CONNECTED state as it is. Do not invent data. Take before screenshots first, then after screenshots at 1280 and 390 px, in dark and light, with Playwright (Chromium at `/opt/pw-browsers`). Run `npm test && npm run typecheck && npm run lint && npm run build`. Commit on your branch, do not push to main, and report in 150 words: files, gates, screenshot folder, and what you could not verify.

---

## 12. Open questions for the owner

1. **Light theme:** keep it as a full counterpart, or ship dark only for now? (Dark only halves the screenshot and contrast work.)
2. **The five places:** confirm the grouping in section 4, especially Studio and Factory under Create, and Calibration and Brain under Insights.
3. **The PR #45 screens** (on a deleted base branch): restore them into the new places, or rebuild from this plan?
4. **Fonts:** approve the three new font packages and the removal of Inter and Fraunces.
5. **The animated mark on login:** WebGL 2 is required. Is the still PNG an acceptable fallback where WebGL is not available?
