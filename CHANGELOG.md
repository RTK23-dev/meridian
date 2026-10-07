# Changelog

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
