# Changelog

## 0.1.0-beta.3 — 2026-10-06

JEV Research now collects and analyzes external Meta video-ad evidence as a research layer. It does not replace or gate JEV decisions.

- A tenant-scoped worker collects bounded, deduplicated Meta Ad Library video records with captured source provenance. A run stores at most 100 MB of source video and each video is capped at 24 MB.
- Public Meta snapshot media is fetched only when an explicit video URL is exposed, validated against the existing SSRF protections, verified as MP4, and stored with a checksum. Unavailable media remains unavailable.
- Local WhisperX transcription stores timestamped segments by content hash. OpenRouter produces versioned typed advertising analysis with evidence references and confidence; low-confidence results require review.
- Research analysis is durably stored with field evidence, confidence, model/prompt provenance, and analysis ids; retries reuse the same transcript/schema/model analysis. Aggregates report observed corpus frequency, not performance or causal evidence. Organization-level summaries contain no cross-brand examples and are used only when the brand has opted into organization learning.
- Repeated external patterns feed the existing opportunity, JEV decision, brief, and Hypit lineage path. Research evidence enriches a matching opportunity rather than creating a duplicate angle.
- Research model runs are recorded for provenance; transient collection/media/transcription/analysis failures use the existing job retries and dead-letter policy.

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
