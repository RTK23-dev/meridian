# Katana: the Meridian redesign plan

The final design brief and build plan for the full Meridian web redesign. It is written to be handed to build agents as it stands. The owner's decisions of the latest review are built in (section 13). Nothing has been built from it yet.

- **Design language reference:** `docs/design/KATANA_DESIGN_PLAN.md`. It holds the exact colour values with their contrast checks, the type scale, the component states and the token file. Where the two disagree, this document wins on structure, flow and theme roles, and the design plan wins on exact token values.
- **Logo:** `docs/design/logo/` (the motion source, the hero still, the GIF and the MP4).
- **Repository rules:** `AGENTS.md` and `CLAUDE.md`. They apply to every task here.

---

## 1. The essence

A katana is one piece of steel and one purpose. Everything that does not serve the cut is taken away, and what is left is exact.

Meridian should feel the same way. One colour is the room, its opposite is the ink, and red marks the one thing that matters on the screen right now. Each screen has one job and one main action. Nothing is decoration, and every line is there because it carries meaning.

**Three words for every review: sharp, quiet, certain.**

- **Sharp:** 2 px corners, hairline edges, exact alignment, a tight type scale. Nothing is soft or blurry.
- **Quiet:** empty space does the work. A screen shows a few things at a time. Red appears only where attention belongs.
- **Certain:** every state is named in words, every number says what it is, nothing pretends, and nothing you started is ever lost.

---

## 2. Experience rules

Each rule has a test a reviewer can run on a screenshot or a click-through.

1. **One screen, one job, one primary action.** Test: a screen has at most one filled red button. Everything else is a quiet button, a link, or sits in a menu.
2. **Step by step, never everything at once.** Test: a task with more than one stage is split into separate step screens, each with one job (section 6). No screen shows the inputs of two stages at once.
3. **Move freely, lose nothing.** Test: on any step, go back, jump ahead to a finished step, switch place, reload, or close the tab. On return, every field, choice and position is exactly where it was (section 7).
4. **Three things above the fold.** Test: at 1280 x 800 the first view holds the page title, one summary, and the single most useful next thing. Anything else is below or one click away.
5. **Five places, no more.** Test: the main navigation has the five places of section 4. Everything else is reached from inside them or from the command palette (Cmd/Ctrl+K).
6. **Show less, reveal on intent.** Test: advanced settings, raw ids, logs and audit detail sit behind a "Details" disclosure, a drawer or a tab, never shown by default.
7. **Say what is missing, in words, where the work happens.** Test: every disabled control, empty state and NOT CONNECTED state names what is missing and the next step, in visible text. (Repository rule: not-connected stays visible and is never faked.)
8. **Short copy.** Test: a page subtitle is one sentence of 14 words or fewer. A button is a verb of at most three words. An empty state is two short sentences and one action.
9. **Every number says what it is.** Test: costs and metrics use the mono face with tabular figures. An estimate starts with "est.". A value with no source reads "not recorded", never 0 and never blank.
10. **Motion explains a change.** Test: every UI animation is 240 ms or shorter and explains a state change. The logo is the only ambient motion: on login, on an empty home, and as the loading mark. With reduced motion on, nothing moves.
11. **The keyboard always works.** Test: every action is reachable with Tab and Enter, the focus ring is a visible 2 px red, and Cmd/Ctrl+K opens the palette anywhere.
12. **Phones get the same product.** Test: at 390 px no page scrolls sideways, touch targets are at least 44 px, and the five places are in a bottom bar.

---

## 3. The look

### 3.1 Two themes, one inverted from the other

Black and white swap; red stays the accent in both.

| Role | Dark theme (default) | Light theme |
|---|---|---|
| Room (page background) | Black #000000 | White #FFFFFF |
| Raised surface (cards, panels) | #0E0E0E | #F4F4F4 |
| Overlay (menus, drawers, palette) | #161616 | #FFFFFF with a 1 px strong edge |
| Ink (primary text, strong lines) | White #FFFFFF | Black #0A0A0A |
| Secondary and muted text | Greys from the token file | Greys from the token file, mirrored |
| Accent | Red #FF2E38 (5.70:1 on black) | Red #C8102E (5.9:1 on white; the brighter red fails contrast on white) |

- The two red values are one role, `accent-red`, tuned per theme so it passes contrast. Both read as the same strong red.
- The theme toggle sits in the account menu. Dark is the default, and the choice is remembered per user.
- The exact greys, hover tones and state colours are in `KATANA_DESIGN_PLAN.md` section b, and both themes are already in its token file (section l). Every component is checked in both themes.

### 3.2 Red is the one accent

Red is used only for:
- the focus ring;
- the current item in navigation or tabs;
- a selected row, card or step;
- the current step in a step bar;
- a running step;
- an unread count;
- the one primary action on a screen;
- the meridian in the logo and the loading mark.

Nothing else is red, and nothing else is coloured, except the state colours (success, warning, danger, info). Those are used only as small dots with words beside them.

### 3.3 Type, shape, edges, space

| | Decision |
|---|---|
| Type | Archivo for display, Instrument Sans for text, JetBrains Mono for numbers, ids and costs. The minimum size is 11 px. The scale is in design plan section c. |
| Shape | A 2 px radius everywhere. Round shapes only for dots, avatars, radios, switch thumbs and the logo. |
| Edges | 1 px hairlines. No shadows anywhere. A floating layer is an overlay surface with a 1 px strong edge. |
| Space | One 4 px scale, with generous outer space and a tight inner rhythm. |

### 3.4 The logo

- **The mark is the meridian globe in `docs/design/logo/`.** It is a wireframe globe with a red meridian.
- **It is the home button.** It sits at the top-left of the shell, at 28 px, with the wordmark "Meridian" beside it when the rail is open. Clicking it goes to Home. It is a real link (`aria-label="Meridian, go to Home"`), so it works with the keyboard and opens in a new tab.
- **It animates in three places only:**
  - Login: the full 3D motion at 160 px.
  - An empty Home for a new workspace: it animates once, then rests.
  - Loading: the spinning logo (section 3.5).
- **Everywhere else it is still:** the hero still, or a flat two-colour version at small sizes.

### 3.5 Loading: the spinning logo

- **The loading mark is the logo spinning:** the globe turns about its axis, carrying its red meridian with the comet running on it, the same motion as the logo's front view.
- **It is lightweight:** an inline SVG or canvas 2D component (`LoadingMark`), not WebGL, so it costs nothing to show. It comes in three sizes:
  - 16 px, inside a button or a row.
  - 24 px, inside a card or a panel.
  - 48 px, for a page or a step that is loading.
- **It reads in both themes:** the globe lines are the ink colour and the meridian is the accent red.
- **It always has a label beside it**, such as "Loading plans" or "Planning the video", or a screen-reader label at 16 px.
- **With reduced motion,** it stands still: the still mark with its label.
- **It is the only loading indicator.** There are no other spinners and no skeleton shimmer. Skeleton blocks may hold the layout, but they do not move.

---

## 4. Information architecture: five places (confirmed)

Today the app has about 30 routes and a long side menu. The redesign groups them into five places. No route is deleted: each old URL redirects to its new home, so links keep working.

| Place | Its one job | What moves in (current routes) |
|---|---|---|
| **Home** | What needs you now, and what is running. | `/` (workspace overview), `/notifications`, `/alerts`, `/brands/$brandId` (brand overview) |
| **Create** | Make a video or an ad, from brief to delivery. | `/content-factory`, `/orchestrator`, `/brands/$brandId/studio`, `/brands/$brandId/factory` |
| **Library** | Everything made or kept. | `/brands/$brandId/library`, `/brands/$brandId/pages`, `/brands/$brandId/products`, `/exports` |
| **Insights** | What the market and our results say. | `/brands/$brandId/market`, `/brands/$brandId/opportunities`, `/brands/$brandId/intelligence`, `/brands/$brandId/learning`, `/brands/$brandId/reviews`, `/brands/$brandId/calibration`, `/brands/$brandId/brain` |
| **Settings** | Connect, configure, check the system. | `/settings`, `/integrations`, `/brands/$brandId/accounts`, `/usage`, `/invite`, `/setup`, and a **System** tab for `/jobs`, `/audit` and `/webhooks` |

- **The brand** is chosen once, in the brand switcher below the logo. Every place then shows that brand. `/brands/new` becomes "New brand" in the switcher.
- **The command palette** (`src/components/command-palette.tsx`) reaches every screen, step and action by name.
- **Inside a place,** a second level appears as tabs at the top of the page, never as more side-menu items.

---

## 5. The shell

```
┌──────────────┬─────────────────────────────────────────────────────────┐
│ (globe) Meridian │  Page title                                ⌘K  🔔 │
│ Brand ▾      │  One-sentence purpose.                    [ Primary ]   │
│              │ ─────────────────────────────────────────────────────── │
│ Home         │  ① Brief ── ② Plan ── ③ Review     (step bar, Create)   │
│ Create       │                                                         │
│ Library      │        the one thing this screen is for                 │
│ Insights     │                                                         │
│ Settings     │                                                         │
│              │                                                         │
│ (you) ▾      │                                                         │
└──────────────┴─────────────────────────────────────────────────────────┘
```

- **Side rail:** 232 px wide, collapsible to 64 px (icons only, with tooltips). Top to bottom:
  - the logo (a link to Home);
  - the brand switcher;
  - the five places;
  - at the bottom, the account menu, which holds the theme toggle and sign out.
  The current place has a red 2 px left edge and ink-coloured text. The others are muted. There are no section headings.
- **Page header:** the title, one sentence and the primary action. Notifications and the palette trigger (⌘K) are quiet icon buttons at the right of the title row. There is no separate top bar.
- **Content:** a max width of 1200 px for working screens and 680 px for reading and forms. The side gutter is 32 px on desktop and 16 px on phones.
- **Phones:** the rail becomes a five-item bottom bar (icon and an 11 px label). The logo and the brand switcher sit in the page header.
- **Code:** `src/components/shell.tsx`, `src/components/workspace.tsx`, `src/components/command-palette.tsx`, `src/components/brand-mark.tsx`, `src/components/ui/layout.tsx`.

---

## 6. The screens, step by step

Any task with stages is a sequence of **step screens**. Each step is its own screen with its own URL, one job and one primary action, which moves to the next step. A **step bar** at the top shows every step:
- **Done:** a check and ink text.
- **Current:** red.
- **Not yet reached:** muted.

Clicking any done step jumps to it. Section 7 makes sure nothing is lost on the way.

### 6.1 Login and first run (steps: Sign in, Name your workspace, Add a brand)
- **Sign in:** a centred column on the room colour. The animated logo at 160 px, the wordmark below it, then the form.
- **Name your workspace:** one field and one red button.
- **Add a brand:** a name and a website. Everything else can wait until later.
- **Code:** `src/routes/login.tsx`, `src/components/home/create-workspace.tsx`, `src/components/setup/`.

### 6.2 Home
- **Title:** "Today". **Sentence:** what needs you and what is running.
- **Needs you:** one list of attention items, each with one action: approvals, failed or paused runs, and NOT CONNECTED accounts.
- **Running now:** a quiet strip below the list, with a 16 px loading mark on each running item.
- **Numbers:** three at most, in mono, each labelled with its source. Anything more goes to Insights.
- **Empty:** the logo animates once, then "Nothing needs you." and one action: "Create".
- **Code:** `src/components/home/`, `src/routes/_app/index.tsx`.

### 6.3 Create: the flagship flow (steps: Brief, Plan, Review)
- **Step 1, Brief:** one large text box for the goal, with three example goals as chips below it.
  - One row of quiet chips: brand, format, budget and model. The model is the stored orchestrator model: read-only, with a link to change it in Settings.
  - Inputs that cannot be attached yet are NOT CONNECTED rows, never fake controls.
  - The chat assistant is a collapsible right drawer, not a second column.
  - Primary action: "Plan it", which saves the draft and opens Plan.
- **Step 2, Plan:** the orchestrator canvas fills the screen.
  - Steps appear as they are planned, joined by hairline edges.
  - A step card shows its kind icon, title, model id (mono), state and cost.
  - The selected step gets a red top edge. A right drawer opens on a step, to change it and see what would re-run.
  - A floating toolbar holds zoom, fit and the run state.
  - While the plan is being written, the 48 px loading mark shows "Planning".
  - Primary action: "Run". When the run is complete, it becomes "Review".
- **Step 3, Review:** the result (player or still), its cost, and the gates (originality, claims, policy, rights) as plain pass, review or blocked rows.
  - Primary action: "Approve", shown only to roles that may approve.
  - "Back to plan" is always available.
- **A plan in progress** shows in the Create landing list ("Continue where you left off") and on Home under Running now.
- **Code:** `src/components/content-factory/`, `src/components/studio/`, `src/components/factory/`, and the Create route files.

### 6.4 Library
- A grid of thumbnails, with search and a filter row of at most three filters (type, status, date).
- A tile opens a right drawer with details and one action.
- **Code:** `src/components/library/`, `src/components/publishing/`.

### 6.5 Insights (tabs: Market, Opportunities, Results, Learning)
- Each tab is one lead chart or list and a "what this means" line. Calibration and the Brain live under Learning, behind "Details".
- Charts are hairline charts in ink and grey, with one red series for the current focus. Every metric is labelled with its source, and "not recorded" is shown where there is none.
- **Code:** `src/components/market/`, `opportunities/`, `learning/`, `reviews/`, `brain/`, `research/`.

### 6.6 Settings (tabs: Workspace, Brands, Connections, Team, Usage, System)
- Each tab is a single column at 680 px.
- Each connection is a row showing its true state (Connected, NOT CONNECTED, or Error with the reason) and one action.
- The System tab holds jobs, health, audit and webhooks, in dense tables with mono ids.
- Connecting an account is a short step sequence (Choose, Authorise, Confirm) using the same step bar.
- **Code:** `src/components/settings/`, `accounts/`, `ops/`, `provider-settings-panel.tsx`.

---

## 7. Navigation and progress: move freely, lose nothing

This is a core promise, so it is a shared system rather than a per-screen habit.

1. **Every screen and step has a URL.**
   - Steps: `/create/brief`, `/create/:planId/plan`, `/create/:planId/review`.
   - Tabs and filters live in the URL's search params.
   - Back, forward, reload and shared links all land on the same view.
2. **Drafts save themselves.** Typed input is saved as a draft about 600 ms after the last keystroke.
   - It is saved through the existing server functions where they exist (Create already stores drafts and plans).
   - Otherwise it is saved to a per-user, per-workspace local draft store, wrapped in try/catch, which the screen restores on return.
   - A quiet "Saved" or "Saving" note sits next to the step bar. Nothing is lost on reload or tab close.
3. **The step bar is a map, not a gate.**
   - Any done step can be opened and changed. Changing an earlier step marks the later steps that depend on it as "to update", rather than wiping them.
   - On the canvas, this is the existing surgical re-run: only the stale steps run again.
4. **Each place remembers where you were.** Leaving Create mid-plan and coming back reopens that plan at that step. Switching tabs in Insights keeps each tab's scroll and filters.
5. **Nothing destructive happens on navigation.** Leaving a screen never discards work, so there are no "Discard changes?" dialogs. A real delete asks once, in the page, never in a browser dialog.
6. **One shared hook** (`useStepState` or similar, in `src/components/ui/` or `src/lib/`) gives every step screen draft save, restore, the "Saved" note and URL sync. It has unit tests.

---

## 8. Components

Restyle the existing primitives in `src/components/ui/`. Do not fork them. Each follows design plan section h for its states, in both themes.

| Primitive | Katana treatment |
|---|---|
| Button (`button.tsx`) | Four variants only:<br>• **primary:** filled red, at most one per screen.<br>• **secondary:** a 1 px ink border.<br>• **quiet:** text only.<br>• **danger:** red text and border.<br>Height is 36 px on desktop and 44 px on coarse pointers. |
| Field, input, select (`field.tsx`, `controls.tsx`) | A 1 px strong border on the raised surface, with the label above at 13 px. Focus is a 2 px red ring. Errors are written below the field. |
| Card (`card.tsx`) | The raised surface with a 1 px hairline, and no shadow. A selected card gets a 2 px red left edge. |
| Table (`data-table.tsx`) | The header in label style, rows divided by hairlines, ids and costs in mono. A selected row gets the red edge. |
| Badge and status (`badge.tsx`, `status-map.ts`) | A dot with text, so colour is never the only signal. NOT CONNECTED is written out in full. |
| Feedback (`feedback.tsx`) | Toasts sit bottom-right on an overlay with a hairline. Empty states are two sentences and one action. Loading uses `LoadingMark`. |
| Layout (`layout.tsx`) | The page header (title, sentence, actions) and the content widths. |
| Theme (`theme.tsx`) | Dark by default, with an inverted light theme. The choice is remembered. |

New primitives, and only these:
- **Drawer:** opens from the right, 480 px wide; closes with Esc.
- **Tabs:** synced to the URL.
- **StepBar:** shows the done, current and not-yet-reached states, and jumps to done steps.
- **LoadingMark:** the spinning logo, at 16, 24 or 48 px, always with a label.
- **Mark:** the logo, as a home link, still or animated.
- **SaveState:** the quiet "Saving" and "Saved" note.

---

## 9. Motion

- **Durations:** 120 ms for hover and press, 180 ms for open and close, 240 ms for a step or page change. One easing curve: cubic-bezier(0.2, 0, 0, 1).
- **What moves:**
  - drawers slide 16 px and fade;
  - a selected item's red edge draws in;
  - a step change slides the content 24 px in the direction of travel (forward goes left, back goes right);
  - canvas steps appear as they are planned;
  - the loading mark spins.
- **What never moves:** layout, text, numbers and anything decorative.
- **Reduced motion:** every UI animation stops, and step changes cut. The loading mark and the logo show their still frame, with labels.

---

## 10. Voice

- Plain, short, active verbs: "Plan it", "Run", "Review", "Approve", "Connect".
- No hype, no exclamation marks, no emoji.
- Say what is missing and what to do: "Meta is not connected. Connect it to publish."
- Name things the way the user does: "videos", "brands", "results", not internal job or table names.

---

## 11. Quality bar: the definition of done for any screen

A screen is done when all of these hold:

1. **Experience rules:** it passes the tests in section 2, checked by a reviewer.
2. **Progress:** navigation and progress pass section 7. The reviewer types on a step, then goes back, forward, reloads and switches places, and nothing is lost.
3. **Tokens only:** no literal colours appear in components. `src/components/ui/tokens.test.ts` passes, extended for the new tokens and for both themes.
4. **Screenshots:** before and after screenshots exist at 1280 px and 390 px, in **both** themes. The PR includes them (`AGENTS.md` rule 10).
5. **No errors or overflow:** no console errors, and no sideways scroll at 390 px.
6. **Keyboard:** every action is reachable, and the focus ring is visible in both themes.
7. **Contrast:** text pairs meet the ratios in the design plan, section b, in both themes.
8. **Repository rules:**
   - Role checks stay on every mutation control (`hasRole`), and tenancy checks stay in server functions.
   - Nothing is faked, and NOT CONNECTED stays visible.
   - No `dangerouslySetInnerHTML` is used with untrusted text.
9. **Gates:** `npm test && npm run typecheck && npm run lint && npm run build` all pass.

---

## 12. The build plan: three agents in parallel, for hours

### 12.1 How the work is split

Three agents work at the same time, each in its own git worktree and branch, on **files that do not overlap**. The lead (the main session) does not build screens. It:
- owns the shared files;
- reviews and merges;
- runs the gates after every merge;
- keeps the progress log;
- answers questions.

| Agent | Owns | Branch |
|---|---|---|
| **Agent 1, Foundation** | Tokens and themes, fonts, every primitive in `src/components/ui/`, `brand-mark.tsx`, the shell, navigation, the command palette, route redirects, the progress system (section 7) | `katana/foundation` |
| **Agent 2, Create and entry** | Login and first run, Home, the whole Create flow (Brief, Plan, Review) | `katana/create` |
| **Agent 3, Library, Insights and Settings** | Library, the four Insights tabs, the six Settings tabs including System, the connect-account steps | `katana/places` |

**Shared files belong to the lead only:**
- `package.json` and `package-lock.json`;
- `src/routeTree.gen.ts` (generated; never edited by hand);
- `src/styles.css` after Agent 1's first merge;
- this plan.

An agent that needs a change in one of them asks the lead, in at most 3 lines.

### 12.2 The contract that lets everyone start at once

Agents 2 and 3 cannot wait hours for the primitives. So Agent 1's **first deliverable, within about 90 minutes, is the API contract**: `src/components/ui/index.ts` exports every primitive in section 8 with its final props and types. The visuals may still be the old ones at that point.

- **Before the contract lands,** Agents 2 and 3 do work that does not need the new primitives:
  - take before screenshots of every screen they own, at 1280 and 390, in both themes;
  - write each screen's content inventory, listing what must stay, what moves behind "Details" and what goes away;
  - write the copy for each screen;
  - write the step-state and route-redirect tests that must pass.
- **After the contract lands,** they build against `@/components/ui` and nothing else for visuals.
- **When Agent 1 restyles a primitive,** every screen picks it up without changes. Agent 1 never changes a primitive's props after the contract, unless the lead agrees.

### 12.3 Phases and sync points

The lead merges in this order. Agents rebase on `run/factory-6h` (the integration branch) after each sync point.

| Time (approx.) | Agent 1, Foundation | Agent 2, Create and entry | Agent 3, Library, Insights, Settings | Sync point (lead) |
|---|---|---|---|---|
| 0:00–1:30 | Tokens for both themes in `src/styles.css`; font swap; the `ui` API contract with stubs | Before screenshots; content inventories; copy; Create step-route design; tests for steps and drafts | Before screenshots; content inventories; copy; redirect table for its routes | **S1:** merge the tokens, fonts and contract. All agents rebase. |
| 1:30–4:00 | Restyle Button, Field, Card, Table, Badge, Feedback, Layout, Theme; build StepBar, Tabs, Drawer, SaveState; build `useStepState` with tests | Login and first run (3 steps); Home | Settings (six tabs; connect-account steps) | **S2:** merge the primitives, then Agent 2, then Agent 3. Gates after each merge. |
| 4:00–6:30 | Build `LoadingMark` (spinning SVG logo) and `Mark` (home link, still and animated); the shell (rail, brand switcher, header, phone bar); the palette; redirects for every old route | Create Brief and Plan (composer, canvas, step drawer), with drafts and step URLs | Library; Insights Market and Opportunities | **S3:** merge the shell first, so every screen sits in the new shell; then Agents 2 and 3. |
| 6:30–9:00 | `/_design` gallery of every primitive and state in both themes; a motion and reduced-motion pass; a contrast pass | Create Review (gates, approve); Continue-where-you-left-off; Running now on Home | Insights Results and Learning (Calibration and Brain behind Details) | **S4:** merge all three. |
| 9:00–end | Cross-screen polish: section 2 tests on every screen, both themes, phones | Polish its screens against section 11 | Polish its screens against section 11 | **S5:** a final review pass; the screenshot set of every place; the release notes. |

The times are guides, not deadlines. Each sync point is a gate: the lead merges only when the branch passes section 11 for the screens it touches and all four repository gates are green. A failing gate goes back to its agent with the exact failure.

### 12.4 Working rules for all three agents

- **Stay in your lane:** work only in the files you own (12.1). Do not change server functions, engine code (`src/engine/`), migrations or contracts. The redesign is presentation, routing and client-side draft state.
- **Never fake anything:** do not invent data, metrics or connected states. If a screen has nothing real to show, design its empty or NOT CONNECTED state instead.
- **No new npm packages:** the fonts are the one planned addition (open question 1). Ask the lead for anything else.
- **Commit often:** commit on your own branch at least every 30 minutes, with a clear message. Never push to `main`, and never rewrite another agent's history.
- **Screenshots:** take them with Playwright (Chromium at `/opt/pw-browsers`), into `docs/design/screens/<agent>/<screen>/`, as before and after, at 1280 and 390, in dark and light.
- **Report back:** at every sync point, report in at most 150 words: what is done, the gate results, the screenshot folder, what is next, and anything not verified.
- **Ask, don't guess:** if something in this plan is unclear or conflicts with a repository rule, ask the lead in at most 3 lines and continue with the rest of your list.

### 12.5 The brief to give each agent

> You are **Agent [1/2/3], [name]**, in the Meridian Katana redesign. Read `docs/design/KATANA_REDESIGN_PLAN.md` in full, and `docs/design/KATANA_DESIGN_PLAN.md` sections b, c, d, e, h and l. You own **[the files in 12.1]** on branch **[branch]** in your own worktree. Follow the timeline in 12.3 and the rules in 12.4. Build only against `@/components/ui` for visuals once the contract lands. Keep every server function call, role check and NOT CONNECTED state as it is, and invent no data. For each screen, take before and after screenshots at 1280 and 390 px in both themes, and meet the definition of done in section 11. Run `npm test && npm run typecheck && npm run lint && npm run build` before every report. Report at each sync point in 150 words or fewer.

---

## 13. Decisions and open questions

**Decided by the owner (this review):**
- The light theme is the dark theme inverted: a white room with black ink and the red accent. Dark is the default.
- The five places of section 4 are confirmed.
- Tasks are split into step screens, with free navigation between them and no lost progress (sections 6 and 7).
- Red is the main accent.
- The meridian globe is the logo, and clicking it goes to Home.
- The loading indicator is the logo spinning.
- The build runs as three parallel agents (section 12).

**Still open:**
1. **Fonts:** approve the three new font packages (`@fontsource-variable/archivo`, `@fontsource-variable/instrument-sans`, `@fontsource/jetbrains-mono`, installed with `--ignore-scripts`) and the removal of Inter and Fraunces.
2. **PR #45 screens** (on a deleted base branch): restore them into the new places, or rebuild from this plan?
3. **WebGL fallback:** where WebGL 2 is not available, is the still logo acceptable on login and the empty Home? (The loading mark does not need WebGL.)
4. **Integration branch:** keep `run/factory-6h` as the branch the three agents merge into, or start a fresh `katana/main` from it?
