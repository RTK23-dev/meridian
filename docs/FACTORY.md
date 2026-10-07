# Content factory

Meridian reuses structure, pacing, hook type and shot style. It does not reuse footage, music, characters, slogans, or a competitor's look. Gates enforce that.

## Loop

Discover → ingest → decode Creative DNA → Winner Score → trends → pick → template → produce → gates → review → paused launch → capped tests → learn.

Each stage is a job on the existing durable SQL queue (`factory.*`), with an idempotency key, retry policy, and a light or media pool.

## Data rights

- **First-party ad accounts** (Meta today): spend, CTR, hold rate, CPA. The only true winner data.
- **Meta Ad Library API** (`ads_archive`): text, dates, platforms, snapshot URL. Store metadata. Snapshot pages are not a bulk creative export.
- **Snapshot video download is off** unless `RESEARCH_SNAPSHOT_MEDIA=1` after an explicit rights review. Bulk harvesting media from snapshot pages collides with Meta's terms.
- **Licensed ad-intelligence providers** and **first-party / uploaded swipe files** are the path for competitor video. No provider is connected yet.
- Missing connections stay `NOT_CONNECTED`. Nothing is invented to fill the board.

## Scores

JEV and Winner Score values are **scores**, not calibrated probabilities. The calibration report (Brier, reliability curve) does not move thresholds. Learning uses a beta-binomial posterior per attribute, with credible intervals and a Benjamini-Hochberg correction. A 5% lift on three creatives is not a winner.

## Owner control

Autopilot levels 0–3 (Suggest, Produce, Stage, Run). The running level cannot exceed the brand ceiling. Spend starts only inside owner-set daily and total caps. A kill switch per brand or workspace pauses live ads. Level 3 is opt-in.

## Production fail-closed

`NODE_ENV=production` or a published deploy without `DATABASE_URL` refuses to boot. The embedded database remains for local preview only.
