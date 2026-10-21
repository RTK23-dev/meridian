# Katana create: content inventory

Wave 1, task B2. Written 2026-10-21 on `katana/create`, based on `e155713`. Pre-work only: no app code changed. Screenshots are scratch files and are not committed.

Sources read: `docs/design/KATANA_REDESIGN_PLAN.md` (sections 1 to 3, 5 to 11, 14; section 6.1 to 6.3 for these screens), `docs/design/KATANA_DESIGN_PLAN.md` (sections b, c, d, e, h, l), `docs/design/tokens/katana-tokens.json`, and the repository rules in `AGENTS.md`. Server functions were found by reading the query hooks (`src/lib/query/hooks.ts`) and each screen's imports.

Decision words: **Stays** (kept, restyled where the plan says so), **Details** (behind a "Details" disclosure), **Goes away** (removed from this screen; the place it goes is named), **New** (added by the plan), **Replaced** (same job, new copy or layout).

---

## 1. What the current screens show

Before screenshots are in `/tmp/claude-0/-home-user-meridian/275fb824-c45c-5a60-b7b0-cd005f5c7e15/scratchpad/design-shots/create/`, named `<screen>-<width>-<theme>.png`. Notes are in `notes.json` and `notes-b1.json` in the same folder.

- **The first-run gate shows on `/`.** With `VITE_AUTH_ENABLED=false` the dev user is signed in with no workspace, so Home shows "Name the workspace" (`home-*.png`).
- **`/content-factory` shows no gate at all.** It renders a blank page, because `ContentFactoryScreen` returns `null` when there is no active workspace (`src/components/content-factory/screen.tsx:46`). Captured as `content-factory-*.png`. Wave 2 replaces this with a "needs a workspace" state that says what is missing and where to go. `screen.tsx` is not changed in wave 1 (coordinator decision).
- **`/orchestrator` renders a recorded example** with fixture data and "No brand yet. Create a brand first." It says no model or provider was called (`orchestrator-*.png`). Keep that label.
- **`/notifications` and `/alerts` show a skeleton that never resolves** without a workspace, because their queries are disabled when there is no organisation id (`notifications-*.png`, `alerts-*.png`). Wave 2 adds a "needs a workspace" state to each.
- **Creating a workspace fails.** The error is "insert or update on table memberships violates foreign key constraint memberships_user_id_fkey" (the known gap; not fixed). The error state is captured as `home-error-1280-dark.png`. Because no workspace exists, no ready state can be captured for Home, Content Factory sessions, plans, the brand overview, notifications or alerts. Those states are described from code below and are marked as such.
- **`/login` redirects to `/`** in this environment, so the sign-in screen is not captured.
- **The brand overview with an unknown id** shows "Something went wrong. The request did not finish." with Details (`brand-overview-*.png`).

## 2. Ownership and conflicts

1. **`attentionItems` name clash.** Resolved by the coordinator: `needsYouItems` sits beside the old export, and `routes/_app/index.tsx` stays on the old export until wave 2.
2. **`src/routes/_app/brands/new.tsx`** (first-run "Add a brand") is Create's (lead decision). Its page already returns a notice to anyone below member (`hasRole(…, "member")`), the role `createBrand` requires on the server.
3. **The login form** (`src/components/settings/auth-shell.tsx`, `email-auth-form.tsx`) sits in Places' `settings/**` folder. Lead decision: the login form is Create's. These files were not edited, so they stay in Places' folder until the lead moves them. The `/login` route and the signed-out front door (`Welcome` in `src/components/gate.tsx`) both use them.
4. **The alerts screen** is `src/components/ops/alerts-center.tsx` (Agent C's `ops/**`). The route `src/routes/_app/alerts.tsx` is B's.
5. **The setup guide** (`src/components/setup/setup-guide.tsx`, B's) is rendered by `src/routes/_app/setup.tsx` (Agent C's route).
6. **First-run brand.** The plan asks for a name and a website. `newBrandSchema` (`src/lib/meridian/schemas/brand.ts`) also requires "What you sell". Lead decision: keep the requirement. The brand step shows "What do you sell?" as a required, labelled field. The schema is not changed.
7. **The orchestrator model picker** (`src/components/content-factory/orchestrator-model-panel.tsx`) has to leave `/content-factory` for the read-only model chip in Brief. Settings has no slot for it yet (Agent C).
8. **Two systems.** Content-factory sessions (`src/lib/meridian/content-factory/actions.ts`) and orchestrator plans (`src/lib/meridian/orchestrator/actions.ts`, statuses in `PLAN_STATUSES`) both exist. B4's Create steps use plan statuses, so a Create `planId` is an orchestrator plan. Where content-factory sessions go (into Create, into Library, or retired) is an owner decision.
9. **Approve.** No plan-level approve action exists. Studio has `approveAndExecuteCreativePlan` and `reviewStudioVariant` (`src/lib/meridian/studio/actions.ts`). Read both before wiring; the first may start execution.
10. **Gate verdicts.** `GateVerdict` (`src/lib/meridian/factory/gates.ts`) covers originality, brand, claims, policy, rights and jev. The plan lists four. The read path for a Create run's verdicts is not confirmed.
11. **Roles.** `/content-factory` and the alerts screen check `hasRole(role, "admin")`. Lead decision: the orchestrator plan, run, step-edit, model-save and model-clear controls are admin-only in the UI, each with a visible reason. The server still requires member for plan, run and step edit, and admin for the model. The server checks are unchanged, so members lose these controls in the UI.
12. **Unsaved-changes bar and guard** (`src/components/forms/unsaved-bar.tsx`, `unsaved-guard.tsx`) are used in 31 files. These include B's `home/create-workspace.tsx`, `brand-overview/brand-details-card.tsx` and the studio steps. Plan 7.5 has no discard dialogs, so wave 2 replaces them with the draft store.
13. **Home shows five numbers.** Plan 6.2 allows three.
14. **Without a workspace,** the notifications and alerts pages never resolve, and `/content-factory` renders nothing (item 1 above).

---

## 3. Screen inventories

### 3.1 Home (`/`)

Code: `src/routes/_app/index.tsx`, `src/components/home/*`.

| Part | Decision | Notes |
|---|---|---|
| Title "Workspace overview" and its sentence | Replaced | Title "Today"; one sentence: what needs you and what is running. |
| "New brand" button (member) | Goes away from Home | The brand is chosen in the switcher (plan section 4). "New brand" moves there (Agent A). |
| KPI row, five cards | Replaced | Three numbers, each with its source: Open reviews, Failed jobs, Live publications. Brands and Last performance sync go to Insights. |
| "Needs attention" list (reviews, failed jobs, provider states, thin brands) | Stays, renamed "Needs you" | Keep approvals (reviews), failed jobs and NOT CONNECTED accounts. Failed, disconnected and degraded providers go to Settings > Connections. Thin brand brains go to the brand overview. |
| Plan items: refused, paused at budget, incomplete | New | From `needsYouItems` (B5). Wave 2 switches Home to it. |
| Running now | New (wave 2) | A quiet strip with a 16 px loading mark on each running item. Home does not load running plans today. |
| Setup callout ("Set up Meridian") | Details | The guide stays at `/setup` (Settings). Home shows one quiet line while required steps are open. |
| Brand grid (search, sort, pipeline and reviews per brand) | Details | The brand switcher replaces the grid. Search and sort stay in Details until the switcher is built. |
| Recent activity (audit feed) | Goes away from Home | Moves to Settings > System (audit, Agent C). |
| Empty: "You're up to date." | Replaced | The logo animates once, then "Nothing needs you." and one action, "Create". |
| Create workspace (no active organisation) | Stays, first run | See 3.2. |

- **Server functions:** `bootstrap` (`src/lib/meridian/api`) through `useWorkspace`, for brands, the active organisation and role, overview metrics and audit; `getMachine` (`src/lib/meridian/machine`), once per brand, for open reviews and pipeline counts; `getSystemStatus` (`src/lib/meridian/system`), for connection phases; `getProviderSettings` and `getDecisionEngines` (`src/lib/meridian/settings/server-actions`), for setup facts. Not loaded yet: plans (for `needsYouItems`) and brand accounts (`getPlatformAccountsAction`, `src/lib/meridian/accounts/actions`). Wave 2 names the sources.
- **States:**
  - Loading: a 24 px loading mark with "Loading your workspace". Today it is a skeleton with an aria-label only.
  - Error: "Reviews could not be loaded. Try again." on the reviews card. A workspace error is the shell's error state.
  - NOT CONNECTED: a Needs you row that names the account and the next step. The badge reads NOT CONNECTED in full.
  - Empty: "Nothing needs you." and "Create".
  - Ready: the Needs you list, three numbers, Running now (wave 2). Not captured.

### 3.2 Login and first run

Code: `src/routes/login.tsx`, `src/components/gate.tsx` (`Welcome`), `src/components/home/create-workspace.tsx`, `src/routes/_app/brands/new.tsx`.

**Sign in** (the `/login` route and the signed-out front door share one screen):

| Part | Decision | Notes |
|---|---|---|
| Headings "Sign in" (login) and "Sign in or create an account" (Welcome) | Replaced | One sign-in screen for both entry points: title "Sign in" and one sentence. |
| Email and password form | Stays, restyled | One red button, "Sign in". |
| "Create an account" switch | Stays, quiet | Opens sign-up. Sign-up has its own title, sentence and button. |
| Animated logo at 160 px, then the wordmark | New | Plan 3.4. Where WebGL 2 is missing, the still mark shows (plan 14.1). |

**First run, step 1: name the workspace** (`create-workspace.tsx`, shown by Home when there is no active organisation):

| Part | Decision | Notes |
|---|---|---|
| Eyebrow "First step" and title "Name the workspace" | Replaced | "Step 1 of 2" and "Name your workspace". |
| Workspace name field and hint | Stays | Hint: "Your company, studio, or agency." |
| "Create workspace" | Stays, the one red button | |
| Unsaved-changes bar and guard | Goes away | Plan 7.5 has no discard dialogs. The draft store keeps the typed name. |
| Error | Stays | A plain sentence; the server message sits behind Details. |

**First run, step 2: add a brand** (`src/routes/_app/brands/new.tsx`; no owner, see item 2):

| Part | Decision | Notes |
|---|---|---|
| Brand name (required) and "What it sells" (required by the form) | Stays | Plan 6.1 asks for name and website only. Owner decision (item 6). |
| Website | Stays | Optional. |
| Industry, category, country, target customers, description | Details | Collapsed under "Details". |
| "Create brand" | Stays, the one red button | |
| Role notice | Stays | For viewers only. |
| Unsaved-changes bar and guard | Goes away | As for step 1. |

- **Server functions:** sign in and sign up through `authClient.signIn.email` and `authClient.signUp.email` (`src/lib/auth/client`). Session through `useCurrentUserState` (`src/lib/auth/use-current-user`). Workspace gate through `bootstrap` (`WorkspaceReady` in `src/components/gate.tsx`). Create workspace: `createOrganization` (`src/lib/meridian/api`), schema `workspaceNameSchema`. Add brand: `createBrand` (`src/lib/meridian/api`), schema `newBrandSchema`.
- **States:**
  - Loading: "Checking your session" on sign-in (today "Checking session…"). A 48 px loading mark with "Loading your workspace" while the workspace loads.
  - Error: the form's own messages on sign-in. On create workspace, the plain sentence with Details (captured).
  - NOT CONNECTED: not applicable.
  - Empty: not applicable.
  - Ready: the form. Captured for step 1 only. Sign-in and step 2 are not captured.

### 3.3 Create: Brief

Code today: `/content-factory` (`src/components/content-factory/*`) and `/orchestrator` (`orchestrator-composer.tsx`). Plan route: `/create/brief`.

| Part | Decision | Notes |
|---|---|---|
| Goal text box, with its count ("0 of 2000 characters") | Stays, one large field | Plan 6.3. The label is "What should the video do?". The count stays as small text. |
| Example goals (four today) | Replaced | Three chips, as plan 6.3 says. Choosing one fills the goal. |
| Brand, format, budget and model chips | Stays | One row of quiet chips (plan 6.3). |
| Model | Stays, read-only | The stored orchestrator model, with a link to change it in Settings (item 7). |
| Budget (USD), from $0.01 to $1,000 | Stays as a chip | Editing sits in Details. The note "if the planning call would cost more than this, no call is made" moves with it. |
| Title, "Format to rebuild or make", "Your inputs", "About the brand" | Details | Visible today. |
| NOT CONNECTED rows: "Reference files", "Brand records" | Stays | Plan 6.3: inputs that cannot be attached yet are NOT CONNECTED rows. |
| Chat messages and attachments (`chat-panel.tsx`) | Stays as a right drawer | Plan 6.3. Attach, search and upload stay NOT CONNECTED until they are wired. |
| Session list and "New session" form (`/content-factory`) | Goes away from Brief | Replaced by the Create landing (wave 2). Owner decision (item 8). |
| Settings panel (duration, priority, genes) | Details | Owner decision (item 8). |
| Recorded replay ("Start the replay", "Restart", 30 events) | Goes away from Brief | Kept only on the empty Plan step, labelled as recorded. |
| "Plan the run" | Replaced | "Plan it". Saves the draft, then opens Plan. |

- **Server functions:** `createOrchestratorDraft` and `planOrchestratorDraft` (`src/lib/meridian/orchestrator/actions`); `getBrandOrchestratorModel` for the model chip; `getOrchestratorModelSetting`, `listOrchestratorTextModels` and `saveOrchestratorModelSetting` for the picker that is still on `/content-factory`. Content-factory chat and sessions (`src/lib/meridian/content-factory/actions`): `listContentFactorySessions`, `createContentFactorySession`, `getContentFactorySession`, `postContentFactoryMessage`, `saveContentFactorySettings`, `attachContentFactorySource`, `searchContentFactorySources`, `uploadContentFactoryFile`.
- **Roles:** `/content-factory` is admin only (`hasRole(role, "admin")`). The orchestrator composer's submit is admin-only in the UI (item 11).
- **States:**
  - Empty (no brand): "No brand yet. Add a brand to start a brief." and "Add a brand".
  - Loading: a 24 px loading mark with "Loading the brief". Today a skeleton that says "Loading Content Factory sessions".
  - NOT CONNECTED: the two input rows, and "No model set. Set one in Settings." when no model is stored.
  - Error: "The brief was not saved. Try again." with Details.
  - Ready: goal, chips, "Plan it". Not captured (needs a workspace).
  - Today without a workspace: blank `/content-factory` and the recorded example on `/orchestrator` (both captured).

### 3.4 Create: Plan

Code today: `/orchestrator` (`orchestrator-screen.tsx`, `orchestrator-canvas.tsx`, `orchestrator-plans.tsx`) and `/content-factory` run panel. Plan route: `/create/:planId/plan`.

| Part | Decision | Notes |
|---|---|---|
| Step canvas (`orchestrator-canvas.tsx`) | Stays, fills the screen | Plan 6.3. Node geometry from `src/engine/orchestrator/layout.ts`. |
| Floating toolbar: zoom, fit, run state | Stays | Today it also counts "0 of 30 events drawn", which belongs to the recorded example only. |
| State legend | Stays, small | Lists the node states and the ten kinds (design plan h). |
| Step card: kind icon, title, model id (mono), state, cost | Stays | "est." for estimates. "No model call" for deterministic steps. |
| Step drawer (selected step) | New | Change a step and see what would run again (plan 6.3). |
| "Change one step" panel (step, output tokens or seconds, model, reset) | Details, in the drawer | Helper text: "Change a step to see its new estimate and which steps would run again." |
| Recorded replay with Start and Restart | Goes away from Plan | Only on the empty Plan step, labelled "Recorded example. Nothing was run." |
| "Your plans" list | Moves to the Create landing | Wave 2: "Continue where you left off". |
| Run feed (events as they happen) | Details | Reveal on intent. Source: the plan's events. |
| Budget pause | Stays | Names the budget and what raises it (design plan h). |
| "Run" (primary), then "Review" when complete | Stays | |

- **Server functions:** `listOrchestratorPlans`, `getOrchestratorPlan`, `runOrchestratorPlan` and `editOrchestratorStep` (`src/lib/meridian/orchestrator/actions`). Today's run panel uses `readContentFactoryRun` and `startContentFactoryRun` (`src/lib/meridian/content-factory/actions`); which run path Create uses is item 8.
- **Roles:** the plan list's Plan, Run and Save step controls are admin-only in the UI (item 11).
- **States:**
  - Empty: "No plan yet. Steps appear here once the brief is planned." and "Back to brief".
  - Loading and planning: a 48 px loading mark with "Planning the video" (plan 6.3).
  - Refused: "The plan was refused. Read the reason, then edit the brief." and "Edit brief". The reason comes from the engine's stored reasons.
  - Paused at budget: "The run paused at its budget. Raise the budget to continue." and "Edit budget".
  - Incomplete: "Some steps did not finish. Run the plan again to finish them." and "Run".
  - NOT CONNECTED: "Connect {provider} to run this step." and "Open Connections". A catalog that cannot be read keeps the existing plain message (`notConnected` in `orchestrator-plans.tsx`).
  - Error: "The run did not start. Try again." with Details.
  - Ready: the canvas. Not captured. Only the recorded example was seen.

### 3.5 Create: Review

Plan route: `/create/:planId/review`. No screen exists for this today. The closest parts are the content-factory run panel and the studio review.

| Part | Decision | Notes |
|---|---|---|
| Result (player or still) | Stays | Source to confirm (item 8). |
| Cost | Stays | "est." for estimates, the recorded value without "est.", and "not recorded" when missing (plan rule 9). |
| Gates: Originality, Claims, Policy, Rights | New layout, same data | Pass, Review or Blocked, each with a word and the verdict's reason. "Not recorded" when no verdict is stored. |
| "Approve" | Stays, the one red button | Role-gated. No plan-level approve exists (item 9). |
| "Back to plan" | Stays, quiet | |
| Shot list and remake (`run-board.tsx`) | Details | `remakeContentFactoryShot`. |
| Run feed | Details | |

- **Server functions:** `getOrchestratorPlan` (plan and events), `readContentFactoryRun` (result and feed) and `remakeContentFactoryShot` (`src/lib/meridian/content-factory/actions`). Approve candidates: `approveAndExecuteCreativePlan` and `reviewStudioVariant` (`src/lib/meridian/studio/actions`), to decide before wiring. Gate verdicts: `GateVerdict` in `src/lib/meridian/factory/gates.ts`, read path not confirmed (item 10).
- **Roles:** Approve is role-gated. The role is not yet confirmed (item 9). Show "Your role cannot approve this result." when the person may not approve.
- **States:**
  - Empty: "Nothing to review yet. The result appears here when the run completes." and "Back to plan".
  - Loading: a 24 px loading mark with "Loading the result".
  - NOT CONNECTED: a gate or provider with no connection, named in its row.
  - Error: "The result could not be loaded." and "Try again".
  - Ready: result, cost, gates, Approve. Not captured.

### 3.6 Brand overview (`/brands/$brandId`)

Code: `src/routes/_app/brands/$brandId/index.tsx`, `src/components/brand-overview/*`. Home place (plan section 4).

| Part | Decision | Notes |
|---|---|---|
| Brand name (title) | Stays | |
| Eyebrow "Brand overview" | New | |
| Sentence: "Complete brand brain · N of M required fields · Version N" | Replaced | "3 of 8 required brain fields are filled." The version number goes to Details. |
| "Open brand brain" (header button) | Replaced | Quiet. Only one red button per screen. |
| Next best action card | Stays, the red button | Labels come from `pipeline.ts`: "Open brand brain", "Open reviews", "Open learning", "Continue to {stage}". Every stage label is one word. |
| "What is missing" checklist | Stays | Each row links to the screen that fills the gap. |
| Pipeline stepper (ten stages with counts) | Details | Plan "show less". |
| Review charts (opportunity rank, review queue age) | Goes away from the overview | Analysis belongs to Insights (Opportunities and Results). |
| Brand details form (name, website, industry, category, country, what you sell, description) | Details | Viewers read it. Member and admin edit it (`canEdit`). Save stays inside Details. |
| Danger zone, "Delete brand" (admin) | Details | Keep the in-page confirm and the copy: "Deleting this brand removes it from your workspace and leaves an audit record." |

- **Server functions:** `getBrand` (`src/lib/meridian/api`); `getMachine`, `listOpportunities` and `listReviews` (`src/lib/meridian/machine`); `updateBrand` and `deleteBrand` (`src/lib/meridian/api`). Roles stay as they are: `canEdit` needs member, `canDelete` needs admin. The pipeline model in `pipeline.ts` is pure and calls no server.
- **States:**
  - Loading: a 48 px loading mark with "Loading brand". Today a skeleton.
  - Error: "This brand could not be loaded. Try again." Captured for an unknown id, with Details.
  - NOT CONNECTED: not shown on this screen.
  - Empty (nothing missing): "Nothing is missing." and "The stored brand data has no gaps." Action: "Open Library".
  - Ready: sentence, next action, checklist. Not captured.

### 3.7 Notifications (`/notifications`)

Code: `src/routes/_app/notifications.tsx`. Home place (plan section 4).

| Part | Decision | Notes |
|---|---|---|
| Title "Notification preferences" and its description | Replaced | Title "Notifications"; one sentence: "Choose which notices appear in your in-app feed." |
| Four switches: learning updates, performance recorded, review required, integration unavailable | Stays | One row each, with On or Off in words. |
| Row sentences ("Shown in your in-app workspace feed.") | Replaced | "Shown in your feed." or "Hidden from your feed." |
| "These preferences do not control external webhook delivery." | Details | Reworded: "Webhook delivery is set elsewhere and does not change here." |
| "Refresh preferences" button | Goes away | Each change reloads the list. |
| "Saving preference…" status | Stays | Only the switch being saved is disabled. |

- **Server functions:** `getNotificationPreferences` and `setNotificationPreference` (`src/lib/meridian/observability/actions`). No role check: the preference belongs to the signed-in person, and the code stays as it is.
- **States:**
  - Loading: a loading mark with "Loading notification preferences". Today a skeleton.
  - No workspace: a skeleton that never resolves (captured). Wave 2 shows a "needs a workspace" state.
  - Error: "Notification preferences could not be loaded. Try again."
  - Empty: "Nothing to choose yet." and "Notice types appear here once the workspace has them." Action: "Back to Home".
  - Ready: four switches. Not captured.
  - Saving: "Saving preference…". Change error: the plain error notice.
- No primary action on this screen.

### 3.8 Alerts (`/alerts`)

Code: `src/routes/_app/alerts.tsx` (route, B) and `src/components/ops/alerts-center.tsx` (screen, Agent C; item 4). Home place (plan section 4).

| Part | Decision | Notes |
|---|---|---|
| Title "Alerts center" and its description | Replaced | Title "Alerts"; one sentence: "Problems Meridian found when it last checked your systems." |
| "Check systems" | Stays, the one red button | Runs a real check (`refreshAlerts`). |
| "Show" filter (open, acknowledged) | Stays | Kept in the URL (plan 7.1). |
| Alert list with Acknowledge | Stays | |
| Delivery target (webhook URL, save, remove) | Details | The status word reads NOT CONNECTED in full. The plan puts webhooks in Settings > System, so this may move there (Agent C). |
| Admin gate (`canAdmin`) | Keep | The whole screen is admin only. |

- **Server functions:** `getAlerts`, `acknowledgeStoredAlert`, `refreshAlerts` and `saveDeliveryTarget` (`src/lib/meridian/alerts/actions`). Role: `hasRole(role, "admin")`, which keeps the screen admin only.
- **States:**
  - Loading: a loading mark with "Loading alerts". Today a skeleton.
  - No workspace: a skeleton with no text (captured, never resolves). Wave 2 shows a "needs a workspace" state.
  - Error: "Alerts could not be loaded. Try again."
  - Empty (none stored): "No alerts recorded." and "Check systems to record any problem that is true now." Action: "Check systems".
  - Empty (filter): "No open alerts." and "Change the filter to see the others."
  - NOT CONNECTED: "Webhook target: NOT CONNECTED", with the next step.
  - Ready: the list. Not captured.

---

## 4. Copy

Each line was counted by a script in the agent's scratch folder (not committed). Sentences must be 14 words or fewer, and each sentence is counted on its own. Button labels must be three words or fewer. Empty states are two short sentences and one action (plan section 2.8). Titles and labels have no limit, but are kept short. Placeholders in braces are filled from data.

| Screen | Part | Copy | Words | Check |
| --- | --- | --- | --- | --- |
| Home | Title | Today | 1 | title |
| Home | Sentence | What needs you, and what is running now. | 8 | ok |
| Home | Primary action | Create | 1 | ok |
| Home | Empty state | Nothing needs you. Start a video when you are ready. | 3 + 7 (10) | ok |
| Home | Empty action | Create | 1 | ok |
| Home | Error | Reviews could not be loaded. Try again. | 5 + 2 (7) | ok |
| Home | Needs you, not connected | Instagram is not connected. Connect it to publish from this brand. | 4 + 7 (11) | ok |
| Home | Needs you action | Connect account | 2 | ok |
| Home | Needs you, plan refused | The plan was refused. Read the reason, then edit the brief. | 4 + 7 (11) | ok |
| Home | Needs you, plan paused | The run paused at its budget. Raise the budget to continue. | 6 + 5 (11) | ok |
| Home | Needs you, plan incomplete | Some steps did not finish. Run the plan again to finish them. | 5 + 7 (12) | ok |
| Home | Needs you action, plan | Open plan | 2 | ok |
| Sign in | Title | Sign in | 2 | title |
| Sign in | Sentence | Sign in with your email and password. | 7 | ok |
| Sign in | Primary action | Sign in | 2 | ok |
| Sign in | Switch to sign-up | Create an account | 3 | ok |
| Sign in | Loading | Checking your session | 3 | label |
| Sign up | Title | Create your account | 3 | title |
| Sign up | Sentence | Your name, email and a password are enough to start. | 10 | ok |
| Sign up | Primary action | Create account | 2 | ok |
| Sign up | Switch to sign-in | Sign in instead | 3 | ok |
| First run: name | Eyebrow | Step 1 of 2 | 4 | label |
| First run: name | Title | Name your workspace | 3 | title |
| First run: name | Sentence | A workspace holds your brands. You can rename it later in Settings. | 5 + 7 (12) | ok |
| First run: name | Primary action | Create workspace | 2 | ok |
| First run: name | Error | The workspace was not created. Try again. | 5 + 2 (7) | ok |
| First run: brand | Eyebrow | Step 2 of 2 | 4 | label |
| First run: brand | Title | Add your first brand | 4 | title |
| First run: brand | Sentence | Name the brand you work on and what it sells. | 10 | ok |
| First run: brand | Primary action | Create brand | 2 | ok |
| First run: brand | Role notice | Only a workspace member can create a brand. | 8 | ok |
| Create: Brief | Title | Brief | 1 | title |
| Create: Brief | Sentence | Describe the video. Plan it when the goal is clear. | 3 + 7 (10) | ok |
| Create: Brief | Primary action | Plan it | 2 | ok |
| Create: Brief | Empty state | No brand yet. Add a brand to start a brief. | 3 + 7 (10) | ok |
| Create: Brief | Empty action | Add a brand | 3 | ok |
| Create: Brief | NOT CONNECTED row | Not connected. Files cannot be attached yet. | 2 + 5 (7) | ok |
| Create: Brief | Model not set | No model set. Set one in Settings. | 3 + 4 (7) | ok |
| Create: Plan | Title | Plan | 1 | title |
| Create: Plan | Sentence | Check each step and its estimate before you run it. | 10 | ok |
| Create: Plan | Primary action | Run | 1 | ok |
| Create: Plan | Empty state | No plan yet. Steps appear here once the brief is planned. | 3 + 8 (11) | ok |
| Create: Plan | Empty action | Back to brief | 3 | ok |
| Create: Plan | Loading | Planning the video | 3 | label |
| Create: Plan | Refused | The plan was refused. Read the reason, then edit the brief. | 4 + 7 (11) | ok |
| Create: Plan | Paused at budget | The run paused at its budget. Raise the budget to continue. | 6 + 5 (11) | ok |
| Create: Plan | Incomplete | Some steps did not finish. Run the plan again to finish them. | 5 + 7 (12) | ok |
| Create: Plan | NOT CONNECTED step | Connect {provider} to run this step. | 6 | ok |
| Create: Review | Title | Review | 1 | title |
| Create: Review | Sentence | Check the result and its gates before you approve it. | 10 | ok |
| Create: Review | Primary action | Approve | 1 | ok |
| Create: Review | Back action | Back to plan | 3 | ok |
| Create: Review | Empty state | Nothing to review yet. The result appears here when the run completes. | 4 + 8 (12) | ok |
| Create: Review | Empty action | Back to plan | 3 | ok |
| Create: Review | Gate not recorded | Not recorded. A person checks this gate before approval. | 2 + 7 (9) | ok |
| Brand overview | Title | Brand name | 2 | title |
| Brand overview | Sentence | 3 of 8 required brain fields are filled. | 8 | ok |
| Brand overview | Primary action | Open brand brain | 3 | ok |
| Brand overview | Empty state | Nothing is missing. The stored brand data has no gaps. | 3 + 7 (10) | ok |
| Brand overview | Empty action | Open Library | 2 | ok |
| Brand overview | Error | This brand could not be loaded. Try again. | 6 + 2 (8) | ok |
| Notifications | Title | Notifications | 1 | title |
| Notifications | Sentence | Choose which notices appear in your in-app feed. | 8 | ok |
| Notifications | Switch on | Shown in your feed. | 4 | ok |
| Notifications | Switch off | Hidden from your feed. | 4 | ok |
| Notifications | Empty state | Nothing to choose yet. Notice types appear here once the workspace has them. | 4 + 9 (13) | ok |
| Notifications | Empty action | Back to Home | 3 | ok |
| Alerts | Title | Alerts | 1 | title |
| Alerts | Sentence | Problems Meridian found when it last checked your systems. | 9 | ok |
| Alerts | Primary action | Check systems | 2 | ok |
| Alerts | Empty state | No alerts recorded. Check systems to record any problem that is true now. | 3 + 10 (13) | ok |
| Alerts | Empty action | Check systems | 2 | ok |
| Alerts | Filter empty | No open alerts. Change the filter to see the others. | 3 + 7 (10) | ok |
| Alerts | NOT CONNECTED target | NOT CONNECTED | 2 | label |

All 74 lines pass the rules (0 failures).

---

## 5. Not verified

- **Ready and data states of every screen.** No workspace can be created (the foreign-key gap), so Home with brands, Content Factory sessions, plans, the brand overview, notifications and alerts with data are described from code only.
- **The sign-in screen.** Auth is disabled in this environment, so `/login` redirects to Home.
- **Gate verdicts and the approve path** (items 9 and 10).
- **Role behaviour** for members and viewers. Only the admin-only and admin-gated screens are read from code.
- **Add a brand** (`/brands/new`) is not captured.
