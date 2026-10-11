# Changelog

## Prerelease — not yet tagged

The next beta tag will be cut after this work is verified on a fresh migrated database. Migrations 0054 to 0057 are new.

**Action for deployments that used environment keys:** provider keys from the environment are now used only when the deployment
opts in with the category's `*_SHARED_DEFAULT` variable (see `docs/PROVIDERS.md`). Set the opt-in, or save the key in Settings.

- **Keys**: every workspace provider key resolves through one resolver. Source connectors each have a key and an opt-in. The Meta Ad
  Library key moved into its own encrypted entry. A deployment key alone no longer makes a source ready.
- **Decisions**: one engine per workspace (TypeSafe JEV or OpenAI Decisions). Compare mode, automatic fallback between engines and the
  OpenRouter decision transport are removed. A malformed engine answer is a provider error, never a coerced value.
- **Video**: Google Veo is removed. Gemini Omni is the only Google video engine and the default. Stored videos play in Studio review and
  the Library, with byte-range support.
- **Storage**: Postgres is the system of record. Drive and S3 hold artifacts and exports. Drive uploads resume from the last confirmed byte,
  and the session is kept in Postgres (migration 0056).
- **Sourcing**: public-page discovery runs end to end with per-source states, provenance on every evidence row, and deduplication by
  canonical URL and content hash (migration 0057).
- **Brand brain**: the 26 fields come from one list. Four are required, and "Complete brand brain" depends only on those. Onboarding
  resumes at the section the person left (migration 0055).
- **Setup**: `npm run setup` is the one command. Settings → General has a setup view and a Drive panel. `.env.example` lists every variable
  the code reads.
- **Honesty**: Facebook, Instagram and YouTube report not connected instead of connected from environment tokens. The Reddit API reports
  not connected. Live posting is not implemented; the manual export package is the delivery path.
- **Controls**: every button acts or shows why it cannot (`npm run ui:button-audit`). The settings screen and the brand switcher state what is
  missing instead of showing a percentage.
- **Cleanup**: removed dead modules (the Instagram graph adapter, the Meta outcome ingestion, the duplicate-evidence helper, the shadow-decision
  flag and others), a stray emoji, and stale comments.
- **Docs**: rewritten. Start at `docs/README.md`. The legacy plugin brief is kept as it was.

Not yet done: see `docs/ROADMAP.md`.

## Unreleased — UI overhaul

The interface was rebuilt in phases. Server-side role checks, tenancy checks, auth and provider logic did not change.

- **Shell and navigation**: the workspace picker sits at the top of the sidebar and the brand picker sits below it on brand pages. The header is one row. Both pickers are in the mobile navigation.
- **Data layer**: reads and writes go through React Query. Writes report pending, success and failure through one hook.
- **Screens**: Home, Settings, Market, Opportunities, Studio, Library, Reviews, Learning, Brain and Factory were redesigned on one design system. The library trace opens in a sheet.
- **Media**: generated images and videos are served from `/api/assets/:assetId`, which checks tenancy and supports byte ranges and cache validators.
- **Operations**: Jobs, Usage, Audit, Alerts, Calibration, Exports and Webhook events have their own screens.
- **Forms**: typed validation shares one schema between browser and server. Field errors and unsaved-change guards appear before submit.
- **Provider keys**: a key typed for one provider category is no longer sent when another category is saved.
- **Accessibility**: one visible focus outline, 44px touch targets on touch screens, one `main` landmark per screen, and tables become cards below the `md` breakpoint. See the design system's accessibility checks. The repository is not certified.
- **Cleanup**: removed the legacy `components/ui.tsx` shim, `components/status.tsx`, and the unused `email-auth`, `audit` and `why-this-drawer` components. Removed the unused `--color-ink` token and the unused `zustand` dependency.

Not verified yet: the unit test suite, the production build, the browser end-to-end suite and axe audits of the redesigned screens. Those run in the testing pass.

## 0.1.0-beta.8 — 2026-10-09

Meridian beta.7 Stabilization Hotfix:
- **Direct TypeSafe JEV System One**: Implemented official `POST https://api.typesafe.ai/v1/systemone` endpoint with Bearer auth; typed parsing for `choice`, `score`, and `noul`; wired shared `JevRouter` across all decision paths with `auto` fallback and `compare` mode telemetry.
- **Google Gemini Omni Video & Model Lifecycle**: Updated to official Interactions API REST payload (`POST /v1beta/interactions`) with `steps[].content[]` video Base64 extraction and SHA-256 verification; marked retired `veo-2.0-generate-001` as `SHUTDOWN` and set active preview to `veo-3.1-generate-preview`.
- **Cyclone Scout Observation**: Replaced guessed `/devices/{id}/health` with supported `/health` and `/api/v1/devices` readiness checks; zero-fabrication for unobserved permalinks, post dates, and view counts.
- **Evidence-Honest Opportunity Scoring & Benchmark Harness**: Removed synthetic `roas = 1.0` default; created versioned Gold Set harness (`benchmark-harness.ts`) evaluating ranking with governance requirements ($N \ge 100$ for `validated`).
- **Live CreativeManifest Studio Wiring**: Wired `CreativeManifest` into Studio generation with mode/strategy gating, preventing `research_only` from submitting generation jobs and mapping manifest beats into durable `CreativeSpec` and `production_jobs.input`.
- **Test Suite Expansion**: Added comprehensive acceptance tests across all hotfix modules (502 tests passing).

## 0.1.0-beta.7 — 2026-10-09

Unified Master Engineering Specification v3: Native Decisions API JEV Router, Google Gemini Omni Video, Strict Metrology & Discovery Truthfulness, 4-Target Viral Intelligence, and Universal Creative Manifest.

- **Dual JEV Provider Router**:
  - Implemented `JevRouter`, `TypeSafeDirectJevProvider`, and `OpenRouterJevProvider` supporting `AUTO`, `TYPESAFE_DIRECT`, `OPENROUTER`, and `COMPARE` provider routing policies.
  - Full adherence to OpenRouter native Decisions API (`POST /api/alpha/decisions`) and model `typesafe/jev-1.13`, preserving exact `choice`, `noul`, and `score` union responses without generic chat-completion fallback.
  - Fail closed with `NOT_CONFIGURED` when credentials or endpoints are missing; comparison mode runs on gold sets without merging answers.
- **Google Gemini Omni Video & Model Lifecycle Registry**:
  - `GeminiOmniVideoProvider`: Google video generation adapter via official Gemini Interactions API (`POST /v1beta/interactions`) with `gemini-omni-1.1-flash`.
  - `ModelCapabilityRegistry`: Tracks model lifecycle, supported tasks/modalities, and shutdown dates. Flags `veo-3.1-generate-preview` shutdown date (2026-10-22) with automated warnings pointing to `gemini-omni-1.1-flash`, while keeping stable GA `veo-2.0-generate-001`.
  - Fully integrated into `ProductionRouter` alongside `veo`, `higgsfield`, `hypit`, and `manual_cloud`.
- **Truthful Metrology & Discovery Fabric**:
  - Removed all synthesized metrics (`15000` default follower count, `Math.max(1000, likes * 15)`, `5000` reels count) across `cyclone-scout-adapter` and `graph-api-adapter`.
  - Missing metrics strictly remain `undefined`/`null`, eliminating artificial outliers and skewed baselines.
- **4-Target Viral Intelligence & Concept Genome**:
  - Decomposed opportunity rating into 4 explicit, distinct targets: `observedBreakoutScore`, `conceptStrengthScore`, `transferPotentialScore`, and `businessPotentialScore`.
  - Business potential strictly returns `null` when downstream telemetry is unavailable.
  - `ConceptGenome`: Versioned entity mapping mechanisms directly to the 11D Angle Bible, supporting organic structures and multi-format concepts.
- **Universal Creative Manifest**:
  - Implemented `CreativeManifest` supporting all creation modes: `research_only`, `image_ad`, `organic_image`, `carousel`, `video_reel_short`, and `mixed_format`.
  - `validateCreationPlan`: Enforces execution safety, strictly preventing `research_only` from spinning up production jobs, and validating required assets and beat lists.
- **Historical Regression Hardening**:
  - Added regression tests 29-35 in `historical-regression.test.ts` verifying all core invariants (35/35 historical regression tests and 484/484 total repository tests passing).

## 0.1.0-beta.6 — 2026-10-09

Final Runtime Integration & Hardening: ProductionRouter, Durable PostgreSQL Jobs, Model-Accurate Adapters, Truthful Nullable Semantics, and End-to-End Integration Gates.

- **ProductionRouter Integration**: Studio generation path completely decouples provider specifics, routing via `CreativeSpec` to `ProductionRouter.route()` across Veo, Higgsfield, Hypit, and ManualCloud.
- **Strict Testing Runtime Isolation**: `test:video` cannot be resolved in `ProductionRuntime` and is strictly confined to `TestingRuntime` via dependency injection.
- **Durable PostgreSQL Job State**: Added migration `0028_durable_production_jobs.sql` persisting `request_id`, `status_url`, `cancel_url`, `spec_hash`, polling timestamps, and resumption metadata to guarantee persistence across worker restarts.
- **Model-Accurate Video Adapters**:
  - `Google Veo Provider`: Validates model-specific `VideoCapability` specifications before remote network calls; parses REST `generatedSamples` for output artifacts.
  - `Higgsfield Provider`: Implements model selection (`dop-v1`, `higgsfield-video-v1`) with official `Authorization: Key` contract and preserves exact upstream request/status/cancel URLs.
- **Truthful Nullable Telemetry & Metrology**: Search-and-replace elimination of `Number(...) || 0` coercion; unobserved views, shares, and completion rates are strictly preserved as `null`, preventing false negatives in Bayesian updates and outlier scoring.
- **Native JEV Decisions API & Strict Protocol**: Strict enforcement of the `answers` object protocol from OpenRouter Decisions API, preserving unadulterated `noul` probabilities without fake confidence, and recording true `NULL` database values.
- **Canonical CreativeStructure**: Formats modeled canonically (`organic_short`, `pov`, `skit`, `listicle`, etc.) with inferred classification heuristics (`heuristicScore`), reserving the 6-beat `AdNarrative` as an optional projection for paid ads.
- **Loud Migration Validation**: Removed `when others then null` in migration `0027` to ensure schema reconciliation fails loudly rather than corrupting tenant state.
- **Comprehensive End-to-End Integration Testing**: 4 representative boundary tests covering organic discovery, production routing, publishing gating, and closed-loop telemetry updates (464/464 total automated tests passing).

## 0.1.0-beta.5 — 2026-10-08

Enterprise JEV Account Intelligence, Multi-Account Credential Vault, Publishing Orchestrator, Unified Telemetry Flywheel, and Operator Control Center.

- **Cryptographic Credential Vault**: AES-256-GCM authenticated encryption for platform credentials with per-brand and per-tenant cryptographic isolation. Multi-account credential assignment across Instagram, Facebook, YouTube, TikTok, Meta Ads, and Google Ads.
- **Multi-Account Platform Manager**: Manage multiple social pages, creator handles, and ad accounts per brand with automated status probing and health monitoring.
- **JEV Large-Scale Multimodal Account Intelligence**: Full 6-beat short-form narrative decomposition (hook, problem, mechanism, demonstration, proof, call-to-action), decile trait performance separation, logistic hook retention curves, and interactive Whitespace Opportunity Radar.
- **Multi-Account Publishing Orchestration**: Deterministic minute-normalized idempotency hashing, atomic PostgreSQL `FOR UPDATE SKIP LOCKED` worker claims, platform rate limits, backoff retry policies, and durable publication receipts.
- **Unified Telemetry & Closed-Loop Bayesian Flywheel**: Multi-channel performance telemetry ingestion (CTR, CVR, ROAS, 3s hook retention, completion rate, share rate) with 14-day half-life exponential recency-decay weighting, conjugate Beta-binomial updating, hierarchical vertical cold-start priors, and Benjamini-Hochberg FDR control.
- **Operator Control Center**: Global Cmd+K / Ctrl+K command palette with instant search and keyboard chords (`G O`, `G S`, `G R`, `G I`, `G L`, `G F`, `G A`), queue observability in `/api/health`, and dedicated worker jobs (`accounts.probe`, `publishing.dispatch`, `telemetry.sync`).
- **Complete Enterprise Documentation**: Comprehensive operator runbooks, security specifications, and architecture guides across all core subsystems.

## 0.1.0-beta.4 — 2026-10-07

Content factory foundation on top of beta.3. Copy the framework, never the ad.

- Production and published deploys refuse to start without `DATABASE_URL`. The embedded database remains for local preview only.
- JEV outputs are labelled as scores, not probabilities. A calibration report records Brier score and a reliability curve without moving thresholds.
- Learning uses a beta-binomial model per attribute with credible intervals and a multiple-testing correction. Thin samples are not stored as winners.
- Rate limits apply to sign-in, invites, uploads, and model-calling server functions (per IP or user).
- Research collection records yield: ads found, videos downloaded, transcripts, snapshot-without-video. Snapshot media stays off unless `RESEARCH_SNAPSHOT_MEDIA=1`.
- Factory job graph (`factory.discover` … `factory.learn`), Winner Score with a range and evidence, ad timelines, Creative DNA v1, trend clusters, abstract storyboard templates, originality/brand/claims/policy/rights gates, Thompson sampling inside caps, and a kill switch.
- Hypit is adapter one behind a `VideoEngine` interface.
- Factory screen: Discover, Templates, Production, Review, Live tests, Learnings. Autopilot levels 0–3. Spending still starts only inside owner-set caps.

Not in this beta: a live Meta round-trip, a licensed ad-intelligence feed, or measured Ad Library yield on a live token. Those stay `NOT_CONNECTED` until configured.

## 0.1.0-beta.3 — 2026-10-06


JEV Research now collects and analyzes external Meta video-ad evidence as a research layer. It does not replace or gate JEV decisions.

- Forms share typed browser/server validation for market collection, competitor records, creative observations, manual performance, paused publishing, performance schedules, and Studio generation choices. Field errors and unsaved state appear before submission; invalid calendar dates are rejected.
- Reject IPv4-mapped and translated private IPv6 targets, non-public IPv6 ranges, and reserved IPv4 ranges before public fetches; malformed address input fails closed.
- Public-page text extraction decodes named and numeric HTML entities exactly once.
- Long-running SQL jobs renew their lease heartbeat while work is active; `claimAndRun` also schedules retries with exponential backoff.
- Webhook deliveries that lose a concurrent duplicate insert race return success.
- The request rate-limiter helper is documented accurately as not wired to routes.
- A tenant-scoped worker collects bounded, deduplicated Meta Ad Library video records with captured source provenance. A run stores at most 100 MB of source video and each video is capped at 24 MB.
- Public Meta snapshot media is fetched only when an explicit video URL is exposed, validated against the existing SSRF protections, verified as MP4, and stored with a checksum. Unavailable media remains unavailable.
- Local WhisperX transcription stores timestamped segments by content hash. OpenRouter produces versioned typed advertising analysis with evidence references and confidence; low-confidence results require review.
- Research analysis is durably stored with field evidence, confidence, model/prompt provenance, and analysis ids; retries reuse the same transcript/schema/model analysis. Aggregates report observed corpus frequency, not performance or causal evidence. Organization-level summaries contain no cross-brand examples and are used only when the brand has opted into organization learning.
- Repeated external patterns feed the existing opportunity, JEV decision, brief, and Hypit lineage path. Research evidence enriches a matching opportunity rather than creating a duplicate angle.
- Research model runs are recorded for provenance; transient collection/media/transcription/analysis failures use the existing job retries and dead-letter policy.
- Approved stored Hypit MP4s now use the existing Meta publisher: Meridian validates the JEV/Hypit/tenant lineage and bytes, reconciles ambiguous upload retries, persists Meta's confirmed video id, then builds the existing paused campaign/ad-set/creative/ad chain. Missing Meta configuration stays `NOT_CONNECTED`; no receipt is fabricated.
- Meta performance scheduling and worker execution verify creative/ad ownership for the same organization and brand. Performance fetches use the organization's credential and confirm access to the selected ad account before observations are stored.
- Workspace forms now share typed browser/server validation for all supported form workflows, including field-level errors and unsaved-change feedback.

Research collection requires `META_AD_LIBRARY_TOKEN`, `OPENROUTER_API_KEY`, local WhisperX, and `ffmpeg`/`ffprobe` on the worker host. Google AI Studio / Nano Banana is optional for image generation. Hypit remains the only production video engine, and the worker no longer executes legacy xAI video jobs. Meta snapshots that do not expose a downloadable video remain unanalyzed. See `docs/PROVIDERS.md` and `docs/SETUP.md`.

## 0.1.0-beta.2 — 2026-10-06

Video generation now follows an approved JEV decision into a separate Hypit process.

- Studio uses Hypit for the production video path. A rejected or unapproved decision creates no job. A missing `HYPIT_BASE_URL` is `HYPIT_NOT_CONNECTED`. A failed Hypit run stores no video.
- A succeeded Hypit artifact is stored, then published through the existing publisher. A missing file, a failed job, or another tenant's artifact is not published.
- Test performance attached to that receipt uses the existing ingestion and `learning.update` path. It is labeled `test:performance` and is not a live ad-account result.
- A public page collected by the existing fetcher is passed into the next brief as untrusted text. The Meta Ad Library stays not connected without its token.
- Setup documents the separate Hypit runtime. Hypit source is not included in this repository.

Not in this beta: a live Meta, TikTok, or Google account, or a claim that synthetic performance is real delivery data.

## 0.1.0-beta.1 — 2026-10-06

First beta of the Meridian application.

- Brand Brain, market evidence, semantic clustering, opportunities, JEV, briefs, Studio, review, publishing clients, performance ingestion, and learning write-back are in the product path.
- JEV is the decision layer for opportunity, brief, and creative QA. Missing or contradictory evidence does not auto-approve. Calibration changes future decisions only after an admin approves a version.
- Historical beta note: video generation used the then-current provider adapter. This has been replaced by the Hypit production path described above.
- Meta, TikTok, Google Ads, and Ad Library clients stay not connected until a request succeeds.
- Invites are stored. Email is sent only when an email API is configured and accepts the message.
- Local setup is documented in `docs/SETUP.md`, with `.env.example` and an embedded Postgres option.
- GitHub Actions runs tests, typecheck, lint, and the production build. The application is not published to npm.

Not in this beta: a hosted ad account, a verified S3 bucket, or a claim that live campaigns are running. Those stay external.
