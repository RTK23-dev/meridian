# Places inventory: Library, Insights and Settings

Wave 1 pre-work for Agent C (Places). Branch `katana/places`, based on `e155713`.

Sources: `docs/design/KATANA_REDESIGN_PLAN.md` sections 2, 4, 6.4 to 6.6, 7 and 14, and the code at this base. Screenshots are in `/tmp/claude-0/-home-user-meridian/275fb824-c45c-5a60-b7b0-cd005f5c7e15/scratchpad/design-shots/places/`. They are not committed.

Scope: every route in the five places of plan section 4. Library, Insights and Settings are inventoried in full. Home and Create belong to Agent B, so their routes are listed at route level, and their keep, move and remove decisions are Agent B's.

---

## 1. Real state of the owned screens

The local database has no workspace. Creating one fails with a foreign-key error, because the dev user has no row in `users`. The workspace-scoped screens therefore show their no-workspace state. No brand exists, so the brand routes were not captured.

Captured: nine routes at 1280 and 390, in dark and light, named `<screen>-<width>-<theme>.png` (36 files, for example `settings-1280-dark.png`). Each was taken after a 10 second wait. Integrations, usage and jobs were checked again after 30 seconds.

| Route | Observed state | Source |
|---|---|---|
| `/settings` | Plain text "Create a workspace first.", with no heading, inside the current shell. Skeleton blocks show first. | `settings.tsx:29` |
| `/usage` | Blank body. | `usage-screen.tsx:19` returns null |
| `/integrations` | Loading skeleton that never resolves (30 seconds). | `integrations.tsx:93` shows the skeleton while `query.data` is empty |
| `/exports` | Blank body. | `exports-screen.tsx:55` returns null |
| `/jobs` | Blank body. | `jobs-screen.tsx:43` returns null |
| `/audit` | Blank body. | `audit-screen.tsx:54` returns null |
| `/webhooks` | Blank body. | `webhook-events-screen.tsx:39` returns null |
| `/invite` | The invitation card: eyebrow "Invitation", heading "Join this workspace", the accept sentence and the action "Go to the workspace". | `invite.tsx` |
| `/setup` | "Create a workspace first, then come back here.", a "Back to the overview" link, and a next-step card. | `setup-guide.tsx:56` |

Checks across all 36 captures: no horizontal scroll at 390 px (0 px on every capture), no console errors, and the theme applied as requested.

Findings for the redesign:
- Five owned routes return a blank body without a workspace, and Integrations never leaves its skeleton. Each needs a designed "Create a workspace first" state (plan section 2, rule 7).
- Settings shows bare text with no heading.

---

## 2. Inventory by place

Each entry lists: the component that renders it (Renders), what stays on the screen (Stays), what moves behind a "Details" disclosure (Behind Details), what goes away (Goes away), the server functions it uses (Server functions), and its states (States).

Server functions are those imported from `src/lib/meridian/**`, plus those reached through the query hooks in `src/lib/query/hooks.ts`, where the hook's `queryFn` is named.

### 2.1 Library

#### `/brands/$brandId/library`: Library > Creatives
- **Renders:** `src/routes/_app/brands/$brandId/library.tsx`, with `src/components/library/*` (creative cards, filters, trace drawer, publish dialog) and `src/components/publishing/paused-explainer.tsx`.
- **Stays:** the creative grid with search and at most three filters (plan 6.4). A tile opens a drawer with one action.
- **Behind Details:** the trace drawer; "Record a creative we already ran" (manual performance and observation forms); the paused-publishing section, "Paid ads, created paused".
- **Goes away:** the heading "Creatives this brand owns", which becomes the subtitle; "Export visible library", which moves to Exports.
- **Server functions:** `listLibrary` (`useLibraryQuery`), `getTrace` (`useTraceQuery`), `listReviews` (`useReviewsQuery`), `getStudioSession` (`useStudioQuery`), `attachCreativeImage`, `recordPerformance`, `recordObservation`, `publishPausedObjects` (`src/lib/meridian/providers/publish-action`).
- **States:** `ScreenSkeleton` while loading; `PlainErrorState` on error; the empty action "Create a creative first". Not observed (no brand).

#### `/brands/$brandId/pages`: Library > Pages
- **Renders:** `src/routes/_app/brands/$brandId/pages.tsx`.
- **Stays:** the list of pages (name, platform, posting weekdays) and the new-page action, which opens the create dialog.
- **Behind Details:** platform, account and weekday fields in the edit dialog.
- **Goes away:** the heading "Pages this brand publishes from", which becomes the subtitle.
- **Server functions:** `listThemePagesAction` (`useThemePagesQuery`), `createThemePageAction`, `updateThemePageAction`, `archiveThemePageAction`, `getPlatformAccountsAction` (`usePlatformAccountsQuery`).
- **States:** the empty action "Create first page"; `ScreenSkeleton`; `PlainErrorState`. Not observed (no brand).

#### `/brands/$brandId/products`: Library > Products
- **Renders:** `src/routes/_app/brands/$brandId/products.tsx`, with `src/components/brain/products-table.tsx` and `product-sheet.tsx`.
- **Stays:** the products table. "Add product" opens the sheet.
- **Behind Details:** the product sheet's fields and ids.
- **Goes away:** none.
- **Server functions:** `getBrand` (`useBrandQuery`).
- **States:** `ScreenSkeleton`; `PlainErrorState`. Not observed (no brand).

#### `/exports`: Library > Exports
- **Renders:** `src/routes/_app/exports.tsx`, which renders `src/components/ops/exports-screen.tsx`.
- **Stays:** four export actions, each with a plain description: opportunities, library, performance rows and, for admins, the audit log. A brand picker serves opportunities and library.
- **Behind Details:** the export-cap sentence (5,000 rows) and the admin note on audit exports.
- **Goes away:** none.
- **Server functions:** `listLibrary` and `listOpportunities` (`src/lib/meridian/machine`), `exportAuditCsv` (`observability/actions`), `getPerformanceRowsForExport` (`performance/actions`), and the CSV builders in `exports/csv`.
- **States:** "No brand to export yet" (`exports-screen.tsx:71`); blank without a workspace (observed).

### 2.2 Insights

#### `/brands/$brandId/market`: Insights > Market
- **Renders:** `src/routes/_app/brands/$brandId/market.tsx`, with `src/components/market/*` and `src/components/research/*`.
- **Stays:** one lead list of stored public evidence ("Analyzed ads" or "Observed creatives"), a "What this means" line, and the action "Find candidates".
- **Behind Details:** the research source rows; "Recent discovery runs"; "Competitors"; the public-page fetch; "Suggestions waiting"; the manual observation form; the collection history.
- **Goes away:** the five forms that sit side by side on one screen. Only one is open at a time, behind Details (plan rule 1).
- **Server functions:** `getMarket` (`useMarketQuery`), `startDiscovery`, `proposeCompetitors`, `suggestFromDocument`, `addCompetitor`, `recordObservation`, `startResearchCollection`, `fetchSourcePage` (all `src/lib/meridian/**`), and a competitor removal action.
- **States:** the Ad Library row shows NOT CONNECTED when the Meta Ad Library key has no secret (`research/actions.ts:195-197`). `ScreenSkeleton`; `PlainErrorState`. Not observed (no brand).

#### `/brands/$brandId/opportunities`: Insights > Opportunities
- **Renders:** `src/routes/_app/brands/$brandId/opportunities.tsx`, with `src/components/opportunities/*`.
- **Stays:** the ranked table, one row per idea, with accept or dismiss. "Rank opportunities".
- **Behind Details:** the opportunity sheet (evidence, decision, probability); the category legend.
- **Goes away:** "Export visible opportunities", which moves to Exports; the long intro paragraph, which the subtitle replaces.
- **Server functions:** `listOpportunities` (`useOpportunitiesQuery`), `refreshOpportunities`, and the accept and dismiss mutations (`useDismissOpportunities`).
- **States:** the empty copy in `src/lib/copy.ts` (`opportunities.empty`); the "Accepted", "Dismissed" and "Rejected" filters; `ErrorState`; `ScreenSkeleton`. Not observed (no brand).

#### `/brands/$brandId/intelligence`: Insights > Results
- **Renders:** `src/routes/_app/brands/$brandId/intelligence.tsx`, with `src/components/market/intelligence-*.tsx` and `trait-rows.tsx`.
- **Stays:** the Account tab's headline numbers and trait rows (top and bottom decile), each labelled with what it counts.
- **Behind Details:** the Whitespace and Semantic tabs (radar and memory), and the creative DNA breakdown.
- **Goes away:** the subtitle jargon, "Macro-portfolio rollups, 6-beat creative DNA decomposition".
- **Server functions:** `getIntelligence` (`useIntelligenceQuery`), `getJevAccountIntelligenceFn` (`useAccountIntelligenceQuery`), and the whitespace status update (`useUpdateWhitespaceStatus`).
- **States:** `EmptyState`, `ErrorState`, `ChartSkeleton`, `ScreenSkeleton`. Not observed (no brand).

#### `/brands/$brandId/learning`: Insights > Learning
- **Renders:** `src/routes/_app/brands/$brandId/learning.tsx`, with `src/components/learning/*` (patterns, performance, schedule and sharing panels).
- **Stays:** Patterns (stored patterns and the decisive-evidence rule) and Performance.
- **Behind Details:** Schedule and Sharing, and the links to Calibration and Brain (plan 6.5).
- **Goes away:** the "Calibration" button in the header, which moves into Details.
- **Server functions:** `getLearning` (`useLearningQuery`). The panels include the action "Recompute patterns".
- **States:** "Not enough results yet to spot a pattern..." (`copy.ts`, `learning.noPattern`); `PlainErrorState`. Not observed (no brand).

#### `/brands/$brandId/reviews`: listed under Insights in plan section 4 (see Q1)
- **Renders:** `src/routes/_app/brands/$brandId/reviews.tsx`, with `src/components/reviews/*`.
- **Stays:** the inbox, with one decision (approve or reject) per item.
- **Behind Details:** engine review items and the review detail.
- **Goes away:** none.
- **Server functions:** `listReviews` (`useReviewsQuery`) and `useResolveReview`.
- **States:** the empty state "Queue clear", with the reason "0 open reviews. No reviews have been created for this brand yet."; "No open reviews in the newest N", with a load-more action; `PlainErrorNotice`. Not observed (no brand).

#### `/brands/$brandId/calibration`: behind Learning > Details
- **Renders:** `src/routes/_app/brands/$brandId/calibration.tsx`, which renders `src/components/ops/calibration-screen.tsx`.
- **Stays:** Proposals (decide) and the Active baseline.
- **Behind Details:** "Grading questions", "How proposals are decided" and "Approved versions".
- **Goes away:** none. The heading "Calibration" becomes the Details link.
- **Server functions:** `decideCalibration` and `proposeCalibration` (`src/lib/meridian/calibration/actions`), `getDecisionCalibrationReport` (`learning/calibration-report-actions`), `getQuestionCalibration` and `recomputeQuestionCalibration` (`calibration/question-actions`), `listCalibrationVersions` (`useCalibrationVersionsQuery`).
- **States:** decisions are admin-only (`hasRole`). Not observed (no brand).

#### `/brands/$brandId/brain`: behind Learning > Details (see Q3)
- **Renders:** `src/routes/_app/brands/$brandId/brain.tsx`, with `src/components/brain/*`.
- **Stays:** section progress, and the first unfinished section (`BrainSetupPanel`).
- **Behind Details:** source material, the logo uploader, the field guide and the autosave indicator.
- **Goes away:** none.
- **Server functions:** `getBrand` (`useBrandQuery`), `saveBrain` and `recordBrainProgress` (`src/lib/meridian/api`).
- **States:** autosave indicator; `ScreenSkeleton`; `PlainErrorState`. Not observed (no brand).

### 2.3 Settings

#### `/settings`: Settings > Workspace (the place root)
- **Renders:** `src/routes/_app/settings.tsx`, which moves to `settings/index.tsx` with the same URL (section 3.1). It renders `src/components/settings/general-tab.tsx`.
- **Stays:** the workspace name form, and a link to the setup guide.
- **Behind Details:** Scoring weights (`weights-tab.tsx`, with a live preview); "Create another workspace"; the Setup keys panel and the provider settings panel (both move to Connections > Details); the Google Drive panel; the note "This build does not delete a workspace, so no control is offered here."
- **Goes away:** the page title, which is the workspace name, and the six-link "Also in Settings" list. The static list "What is and is not connected" also goes, because the connection rows replace it. Some of its lines describe this environment without data behind them, for example "This environment has no ad account."
- **Server functions:** `bootstrap` (`src/lib/meridian/api`, read by the workspace provider); `createOrganization` and `renameOrganization` (`api`); `updateWeights` (`api`); the Setup panel's `saveProviderConfig`, `removeProviderConfig`, `testProviderConnection` and `saveVideoBudget` (`src/lib/meridian/settings/server-actions`); the Drive panel's `getDriveConnection`, `checkDriveConnection` and `disconnectDrive` (`storage/drive-connection-actions`).
- **States:** "Create a workspace first." (observed); form pending and `FormError` states.

#### `/settings/brands`: Settings > Brands (new route)
- **Renders today:** `src/components/settings/learning-tab.tsx` (shared workspace patterns, per brand) and `danger-tab.tsx` (delete a brand). There is no route yet.
- **Stays:** the brand list, with the "Use shared workspace patterns" switch and the "Open learning" link for each brand.
- **Behind Details:** the "What turning this on changes" dialog; "Delete a brand", which links to the brand overview, where deletion happens.
- **Goes away:** the "Danger zone" tab name.
- **Server functions:** `setOrganizationLearning` (`src/lib/meridian/machine`); the `BrandSummary` type (`workspace/actions`).
- **States:** "There are no brands to delete." (`danger-tab.tsx:17`); the switch is admin-only.

#### `/integrations`: Settings > Connections
- **Renders:** `src/routes/_app/integrations.tsx`, with `src/components/settings/provider-card.tsx`, `setup-panel.tsx` and `integration-model.ts`.
- **Stays:** one row per account (Meta, TikTok, Google Ads and Meta Ad Library), built by `connection-state.ts` (label, reason, one action). The Google AI Studio key row keeps its test action.
- **Behind Details:** deployment settings (Embeddings, Hypit video, Email), shown read-only as "Set on the server"; key entry (the Setup panel); the provider settings panel; Google Drive; the publishing line; a "Brand accounts" link to `/brands/$brandId/accounts`.
- **Goes away:** the h1 "Workspace logins", which becomes the subtitle; the "Background processes" block (worker, scheduler and database), which moves to System (`/jobs`).
- **Server functions:** `getSystemStatus` (`useIntegrationsQuery`), `getProviderSettings` (`useProviderSettingsQuery`), `probeProviderConnection`, `disconnectProvider` and `reconnectProvider` (`src/lib/meridian/providers/connect`), `beginOauth` (`oauth/begin`), `refreshStoredToken` (`oauth/refresh`), `testProviderConnection` and `removeProviderConfig` (`settings/server-actions`).
- **States:** the loading skeleton "Loading integration status"; `PlainErrorState`; the key rows say "Loading provider settings." or "Provider settings could not be loaded." (`integration-model.ts`); the non-admin note "An admin tests and changes providers." Observed: skeleton that never resolves when no workspace exists.

#### `/brands/$brandId/accounts`: Settings > Connections, "Brand accounts"
- **Renders:** `src/routes/_app/brands/$brandId/accounts.tsx`, with `src/components/accounts/*`.
- **Stays:** the platform list, with one connect or disconnect action per platform, and "Connect an account".
- **Behind Details:** the manual account-id paste (`accounts/paste.ts`) and the sign-in readiness reason.
- **Goes away:** the long paragraph under the heading, which the subtitle replaces.
- **Server functions:** `getPlatformAccountsAction` (`usePlatformAccountsQuery`); `connectPlatformAccountAction` and `disconnectPlatformAccountAction` (`useScopedMutation`); `beginOauth` (`oauth/begin`); `oauthClientReadinessAction` (`oauth/readiness`).
- **States:** "No accounts yet. A workspace admin can connect one."; the sign-in reasons from `signInState` (`accounts/oauth-connect.ts`), which say that only an admin can start sign-in, that the deployment's sign-in settings are being checked, or which settings are missing; `ScreenSkeleton`; `PlainErrorState`.

#### `/usage`: Settings > Usage
- **Renders:** `src/routes/_app/usage.tsx`, which renders `src/components/ops/usage-screen.tsx`.
- **Stays:** three figures, Recorded runs, Tokens and Cost, in the mono face, and the "By operation" table.
- **Behind Details:** the "By day" table and the token columns.
- **Goes away:** the page heading "Usage & cost", which becomes the tab name.
- **Server functions:** `listUsage` (`useUsageQuery`).
- **States:** "No model runs are recorded yet."; "No daily usage is recorded yet."; "Loading usage and cost"; `PlainErrorState`; a separate message for non-admins (`usage-screen.tsx:20`); blank without a workspace (observed).

#### `/settings/team`: Settings > Team (new route)
- **Renders today:** `src/components/settings/members-tab.tsx`.
- **Stays:** the member list with roles; "Pending invitations"; "Invite member".
- **Behind Details:** role change; removing a member (confirmation dialog).
- **Goes away:** none.
- **Server functions:** `addMember` and `changeMemberRole` (`src/lib/meridian/api`); members and invitations come from `bootstrap`; `ROLES` (`access`).
- **States:** "No members yet" (`members-tab.tsx:96`); the invite and remove dialogs.

#### `/invite`: not a tab; the landing page for an emailed invitation
- **Renders:** `src/routes/_app/invite.tsx`.
- **Stays:** the card: eyebrow "Invitation", heading "Join this workspace", and the action "Go to the workspace".
- **Behind Details:** the server's error text, shown through `plainServerError`.
- **Goes away:** none.
- **Server functions:** `acceptInvite` (`src/lib/meridian/api`), through `useScopedMutation`.
- **States:** the accept sentence (observed); `FormError` on failure.

#### `/setup`: reached from Settings > Workspace, not a tab
- **Renders:** `src/routes/_app/setup.tsx`, which renders `src/components/setup/setup-guide.tsx`.
- **Stays:** the step list with one next step, and the progress line "X of Y required steps done".
- **Behind Details:** "Every provider in one list" (`setup-advanced`).
- **Goes away:** none.
- **Server functions:** `getDecisionEngines` (`useDecisionEnginesQuery`), `getProviderSettings` (`useProviderSettingsQuery`), `hasRole`.
- **States:** step statuses "Done", "Do this now", "To do", "Optional", "Could not check" and "Not set up"; "Loading setup..."; the no-workspace text (observed).

#### `/jobs`: Settings > System
- **Renders:** `src/routes/_app/jobs.tsx`, which renders `src/components/ops/jobs-screen.tsx` and `job-detail-sheet.tsx`.
- **Stays:** worker and scheduler status (from the heartbeat), the jobs table with a status filter, and the row actions Retry and Cancel, which are admin-only.
- **Behind Details:** the job sheet (payload fields, last error, result, raw ids).
- **Goes away:** the heading "Jobs & health", which becomes the tab name.
- **Server functions:** `listJobs` (`useJobsQuery`), `getWorkerHealth` (`useWorkerHealthQuery`), `getJobDetail` (`useJobDetailQuery`), `retryJob` and `cancelJob` (`useJobActionMutation`).
- **States:** "Loading worker health"; "No jobs are stored yet", "No jobs match these filters" and "No jobs to show"; `PlainErrorState`; a plain message for non-admins (`jobs-screen.tsx:44`); blank without a workspace (observed).

#### `/audit`: Settings > System, "Audit log"
- **Renders:** `src/routes/_app/audit.tsx`, which renders `src/components/ops/audit-screen.tsx`.
- **Stays:** the newest-first table (time, actor, action, brand), with filters for actor, action, brand and dates, and pagination.
- **Behind Details:** raw actor and entry ids; the CSV export ("Export matching entries").
- **Goes away:** none.
- **Server functions:** `listAuditPage` and `exportAuditCsv` (`src/lib/meridian/observability/actions`).
- **States:** "Loading audit log"; "No audit entries yet"; "No audit entries match these filters"; `PlainErrorState`; blank without a workspace (observed).

#### `/webhooks`: Settings > System, "Webhook events"
- **Renders:** `src/routes/_app/webhooks.tsx`, which renders `src/components/ops/webhook-events-screen.tsx`.
- **Stays:** the table of received events (provider, identifier, time), with a provider filter and pagination.
- **Behind Details:** raw event identifiers.
- **Goes away:** none.
- **Server functions:** `listWebhookEvents` (`src/lib/meridian/observability/actions`).
- **States:** "Loading webhook events"; "No webhook events are recorded"; "No events for this provider"; "No webhook events match"; blank without a workspace (observed).

### 2.4 Home and Create (Agent B; route level only)

| Route | Renders | Server functions (module or hook) | States |
|---|---|---|---|
| `/` | `src/routes/_app/index.tsx`, `src/components/home/*`, `src/components/setup/setup-callout.tsx` | `bootstrap`, `createOrganization` (`api`); `getMachine` (`useMachinesQuery`); `workspace/actions` types | Title "Workspace overview". Not captured in this run. |
| `/notifications` | `src/routes/_app/notifications.tsx` | `getNotificationPreferences` (`useNotificationPreferencesQuery`), `setNotificationPreference` (`observability/actions`) | Title "Notification preferences". Not captured. |
| `/alerts` | `src/components/ops/alerts-center.tsx` | `getAlerts` (`useAlertsQuery`), `refreshAlerts`, `saveDeliveryTarget` (`alerts/actions`), `useAcknowledgeAlert` | Title "Alerts center". Not captured. |
| `/brands/$brandId` | `src/routes/_app/brands/$brandId/index.tsx`, `src/components/brand-overview/*` | `getBrand` (`useBrandQuery`); `brainCompleteness` (`brain`); `machine-counts` | Not captured (no brand). |
| `/content-factory` | `src/components/content-factory/screen.tsx` | `content-factory/actions`, `feed`, `service`; `orchestrator/actions` | "Content Factory"; "No sessions yet". Not captured. |
| `/orchestrator` | `src/components/content-factory/orchestrator-screen.tsx` | `orchestrator/actions` | Heading "Orchestrator plan (recorded example)". Agent B should confirm the example is labelled as one. |
| `/brands/$brandId/studio` | `src/routes/_app/brands/$brandId/studio.tsx`, `src/components/studio/*` | `getStudioSession` (`useStudioQuery`); `studio/actions`; `machine`; `distribution/actions` | Heading "Make the next ads from evidence". Not captured (no brand). |
| `/brands/$brandId/factory` | `src/routes/_app/brands/$brandId/factory.tsx`, `src/components/factory/*` | `getFactoryBoard` (`useFactoryQuery`); `factory/actions`, `pipeline-actions`, `sleep-actions`; `shopify/actions` | Heading "Watch, copy the framework, never the ad". Not captured (no brand). |

The keep, move and remove decisions for these routes are Agent B's. This table gives the module mapping for `places.ts`.

---

## 3. Target layout

### 3.1 Route files

- **Moves:** `src/routes/_app/settings.tsx` becomes `src/routes/_app/settings/index.tsx`. The URL stays `/settings`. The `createFileRoute` path becomes `/_app/settings/`. The lead regenerates `src/routeTree.gen.ts`.
- **Added in wave 2 (Agent C):** `src/routes/_app/library/index.tsx` and `src/routes/_app/insights/index.tsx` (place roots, section 3.2); `src/routes/_app/settings/brands.tsx` and `src/routes/_app/settings/team.tsx` (new tabs).
- **Unchanged:** every other route in section 4 keeps its file and its URL.
- **Not deleted:** no route is removed. Canonical redirects are a later task (plan 14.2).

### 3.2 Place roots

- `/library` opens the active brand's Creatives tab (`/brands/$brandId/library`).
- `/insights` opens the active brand's Market tab (`/brands/$brandId/market`).
- `/settings` is the Workspace tab, at its own URL.
- With no active brand, a root shows its "New brand" empty state (section 4.1). The active brand comes from the brand switcher (Agent A, wave 2).

### 3.3 Tabs, in order, each a route

| Place | Tabs, in order | Routes |
|---|---|---|
| Library | Creatives, Pages, Products, Exports | `/brands/$brandId/library`, `/brands/$brandId/pages`, `/brands/$brandId/products`, `/exports` |
| Insights | Market, Opportunities, Results, Learning | `/brands/$brandId/market`, `/brands/$brandId/opportunities`, `/brands/$brandId/intelligence`, `/brands/$brandId/learning` |
| Settings | Workspace, Brands, Connections, Team, Usage, System | `/settings`, `/settings/brands`, `/integrations`, `/settings/team`, `/usage`, `/jobs` |
| Settings > System (second level) | Jobs & health, Audit log, Webhook events | `/jobs`, `/audit`, `/webhooks` |

Routes that are not tabs:
- Insights > Learning > Details: `/brands/$brandId/calibration` and `/brands/$brandId/brain`.
- Settings > Connections: "Brand accounts" links to `/brands/$brandId/accounts`.
- Settings > Workspace: a link to `/setup`.
- `/invite` is the landing page for an emailed link. It is not in any tab.
- Home holds `/alerts` and `/notifications`.

### 3.4 Place mapping (for `src/lib/navigation/places.ts`, Agent A, wave 2)

- **Library:** `/library`, `/brands/$brandId/library`, `/brands/$brandId/pages`, `/brands/$brandId/products`, `/exports`.
- **Insights:** `/insights`, `/brands/$brandId/market`, `/brands/$brandId/opportunities`, `/brands/$brandId/intelligence`, `/brands/$brandId/learning`, `/brands/$brandId/calibration`, `/brands/$brandId/brain`, `/brands/$brandId/reviews` (see Q1).
- **Settings:** `/settings` and `/settings/*`, `/integrations`, `/brands/$brandId/accounts`, `/usage`, `/jobs`, `/audit`, `/webhooks`, `/setup`, `/invite`.
- **Home:** `/`, `/notifications`, `/alerts`, `/brands/$brandId`, and any path not listed (plan 14.2).
- **Create:** `/content-factory`, `/orchestrator`, `/brands/$brandId/studio`, `/brands/$brandId/factory`.

### 3.5 What leaves the side menu

The current menu (`src/lib/navigation/model.ts`) has seven groups and the six links in `SETTINGS_SCREEN_LINKS`. Its items become places, tabs or Details. The groups are Overview, Settings, Brand, Research, Create, Review and Results. The six links are Usage & cost, Alerts center, Audit log, Webhook events, Exports and Notification preferences. No URL is removed.

---

## 4. Copy

Rules: a subtitle is one sentence of 14 words or fewer. A button label is a verb of three words or fewer. An empty state is two sentences and one action (plan section 2, rule 8). Labels marked (existing) were taken from the code. Every other label is a proposal.

### 4.1 Place roots

| Surface | Subtitle | Empty state | Action |
|---|---|---|---|
| Library, `/library` | Everything your brands have made or kept, in one place. | Nothing is in the library yet. Add a brand, then make its first video or ad. | New brand |
| Insights, `/insights` | What the market and your results say, with the source of each number. | No brand is set up for insights yet. Add a brand, then find its first public ads. | New brand |
| Settings, `/settings` (Workspace) | Name this workspace and check what it still needs. | No workspace is set up yet. Create one, then name it here. | Create workspace |

### 4.2 Library tabs

| Tab | Subtitle | Buttons | Empty state | Action |
|---|---|---|---|---|
| Creatives | Every creative this brand owns, with its status and results. | Record a result (new); Make something (new) | No creatives are saved for this brand yet. Make the first video or ad in Create. | Make something |
| Pages | The pages this brand publishes from, and when each one posts. | New page (new) | No pages are set up for this brand yet. Add a page to choose where its videos go. | New page |
| Products | The products this brand sells, so each video and ad can name one. | Add product (existing) | No products are listed for this brand yet. Add one before making its first video. | Add product |
| Exports | Download opportunities, library, performance or audit rows as a file. | Export opportunities; Export library; Export performance rows; Export audit log (existing) | No brand is set up to export yet. Add a brand, then choose it here. | New brand |

### 4.3 Insights tabs

| Tab | Subtitle | Buttons | Empty state | Action |
|---|---|---|---|---|
| Market | What public ads and pages show, with the source for each item. | Find candidates (existing) | No public ads or pages are stored for this brand yet. Find candidates to start collecting them. | Find candidates |
| Opportunities | Ideas to make next, ranked from stored evidence and labelled as ideas. | Rank opportunities (existing) | Nothing is ranked yet. Ranking uses the brand brain, stored observations and learned patterns, and invents no competitors. | Rank opportunities |
| Results | How stored posts and creatives performed, with counts that do not show cause. | None | No posts or creatives are stored for this brand yet. Results appear after a creative runs and its performance is recorded. | Record a result |
| Learning | Patterns the engine has stored, each with the evidence that let it stand. | Recompute patterns (existing) | Not enough results yet to spot a pattern. Patterns appear after a few ads have run. | Open Results |

### 4.4 Settings tabs

| Tab | Subtitle | Buttons | Empty state | Action |
|---|---|---|---|---|
| Workspace | Name this workspace and check what it still needs. | Save name (new); Open setup guide (new) | See 4.1 | See 4.1 |
| Brands | The brands in this workspace and whether each one shares its learning. | New brand (new) | No brands are in this workspace yet. Add a brand, then connect its accounts. | New brand |
| Connections | Each connection, its true state, and the one action it needs. | Connect; Reconnect; Test connection (existing); Refresh status (new) | No workspace is set up yet. Create one, then connect its accounts. | Create workspace |
| Team | Who has access to this workspace, and who has been invited. | Invite member (existing) | No members are listed yet. Invite someone, and they join with the role you choose. | Invite member |
| Usage | Model runs and what they cost, with any unreported cost left unknown. | None | No model runs are recorded yet. Runs appear here once a video or ad starts making them. | Make something |
| System, Jobs & health | Whether background work is running, and what is queued or failed. | Retry; Cancel (existing) | No jobs are stored yet. Jobs appear here when a video, ad or learning run starts. | Make something |
| System, Audit log | What people in this workspace changed, newest first. | Export matching entries (existing) | No changes are recorded yet. Entries appear as people change settings, brands or runs. | Open Jobs |
| System, Webhook events | Events received from connected services, with the time each arrived. | Apply filter (existing) | No webhook events are recorded yet. Events appear after a connected service sends one. | Open Connections |

### 4.5 Connection row labels (`src/components/settings/connection-state.ts`)

| Label | Tone | When | Action |
|---|---|---|---|
| Connected | success | Status HEALTHY or CONNECTED, with a readable time of the last successful request | Test connection |
| NOT CONNECTED | neutral | NOT_CONFIGURED, NOT_CONNECTED, SUPPORTED, DEGRADED, DISCONNECTED, or an unknown or missing status | Connect for the OAuth providers (`/integrations`); Reconnect when disconnected; otherwise Test connection |
| Error | danger | FAILED, FAILURE, ERROR or UNHEALTHY. The reason is the recorded error, else the server's sentence, else "No reason was recorded." | Test connection |
| Checking | info | CONNECTING or SYNCING | Refresh status |

The server's own sentence is shown as the reason whenever it is present. A fallback sentence is used only when the server sends none, and no fallback mentions credentials.

---

## 5. Open server issue (not changed in this build)

Recorded at the coordinator's request. The owner decides the fix (plan 14.7). Provider logic was not changed.

- `src/lib/meridian/system.ts:58` selects the stored `status` column, and nothing reads it.
- `src/lib/meridian/system.ts:63-68` computes each row's `phase` with `phaseForProbe`, and does not pass `configured`. Line 90 does the same in the fallback list.
- `src/lib/meridian/providers/live.ts:19-22` defines `providerConfigured()`, which always returns `false`. Line 93 uses it as the default for `configured`.
- `src/lib/meridian/providers/phase.ts:30-32` returns NOT_CONFIGURED for any row without `configured`, before the recorded success is read.

Effect: `getSystemStatus` reports every provider row that is not disconnected as NOT_CONFIGURED, with the server's sentence, even when `provider_connections` holds a success time or a HEALTHY status. The Connections rows show that as NOT CONNECTED, which fails closed. The app does not add its own credential claim.

---

## 6. Decisions for the lead (owner, per plan sections 13 and 14)

- **Q1, Reviews.** Section 4 places `/brands/$brandId/reviews` under Insights. Section 6.5 gives Insights four tabs, and Reviews is not one of them. Proposed: keep the route mapped to Insights, with no tab, and link it from Home's "Needs you" list.
- **Q2, `/invite`.** It is the landing page for an emailed link, not a screen to navigate to. Proposed: keep it out of the tabs, and map it to Settings only for highlighting.
- **Q3, Brain.** It is a setup screen. Section 4 places it under Insights. Proposed: behind Learning > Details, as section 6.5 says.
- **Q4, Place roots.** `/library` and `/insights` need the active brand from the switcher (Agent A). Proposed: each redirects to the active brand's first tab.
- **Q5, New tab routes.** `/settings/brands` and `/settings/team` are new URLs. The alternative is search params (plan section 7). Section 14.2 says tabs are routes, so this inventory follows 14.2.
- **Q6, Connect step route.** Connecting is a three-step flow (Choose, Authorise, Confirm; plan 6.6). Proposed route: `/integrations/connect/$provider`, added in wave 2. Until it exists, Connect goes to `/integrations`.
- **Q7, Static copy.** The General tab's list "What is and is not connected" goes, and the connection rows replace it. Confirm.
- **Q8, DEGRADED.** A stale last success reads NOT CONNECTED (neutral), with the server's sentence, not Error. This matches Home's attention model, which treats degraded as neutral. Confirm.
- **Q9, Scope of the connection model.** It covers the four account rows only. The Google AI Studio key row and the deployment rows (Embeddings, Hypit video, Email) keep their own server state words, because AVAILABLE and CONFIGURED are not connection states. Confirm.

---

## 7. Known gaps

- Creating a workspace fails with a foreign-key error (the dev user has no `users` row). The only states observed are the no-workspace states in section 1.
- No brand exists, so every brand-scoped state is unobserved.
- Home and Create are listed at route level only.
