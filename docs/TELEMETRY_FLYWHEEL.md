# Unified Performance Telemetry & Closed-Loop Bayesian Flywheel

Meridian provides an integrated cross-channel performance telemetry and closed-loop Bayesian learning flywheel (`src/lib/meridian/learning/telemetry-engine.ts`), introduced in migration `0024_unified_telemetry.sql`.

This system ingests both paid ad telemetry (Meta Ads, TikTok Ads, Google Ads) and organic social performance (Instagram Reels, TikTok posts, YouTube Shorts), applies continuous exponential recency decay, calculates Bayesian feature posteriors, and closes the cognitive feedback loop directly into JEV account profiles and creative briefs.

---

## 1. Unified Telemetry Schema (`unified_performance_telemetry`)

The database stores granular, observation-level metrics for every published variant:

| Field | Type | Description |
|---|---|---|
| `id` | `text PRIMARY KEY` | UUID of the telemetry row |
| `organization_id` | `text NOT NULL` | Tenant organization boundary |
| `brand_id` | `text NOT NULL` | Brand boundary |
| `publish_job_id` | `text` | Link to originating `publishing_queues` job |
| `account_id` | `text` | Link to destination `platform_accounts` record |
| `platform` | `text NOT NULL` | `instagram`, `tiktok`, `youtube`, `meta`, `facebook`, `linkedin`, `x` |
| `source_type` | `text NOT NULL DEFAULT 'organic'` | `organic`, `paid`, or `hybrid` |
| `creative_id` | `text` | Link to creative record |
| `hook_type` | `text` | Hook archetype (`contrarian`, `question`, `statistic`, `visual_shock`, etc.) |
| `angle` | `text` | Creative angle (`founder_story`, `problem_agitation`, `secret_hack`, etc.) |
| `views` | `integer NOT NULL DEFAULT 0` | Total video views |
| `reach` | `integer NOT NULL DEFAULT 0` | Unique audience reach |
| `clicks` | `integer NOT NULL DEFAULT 0` | Link/sticker clicks |
| `engagements` | `integer NOT NULL DEFAULT 0` | Likes, comments, reactions |
| `shares` | `integer NOT NULL DEFAULT 0` | Video shares |
| `saves` | `integer NOT NULL DEFAULT 0` | Video bookmarks/saves |
| `conversions` | `integer NOT NULL DEFAULT 0` | Conversions/purchases |
| `spend_cents` | `integer NOT NULL DEFAULT 0` | Paid spend in cents |
| `revenue_cents` | `integer NOT NULL DEFAULT 0` | Attributed revenue in cents |
| `hook_retention_3s` | `double precision` | 3-second hook retention rate ($0.0 - 1.0$), or `null` if unobserved |
| `completion_rate` | `double precision` | Full video completion rate ($0.0 - 1.0$), or `null` if unobserved |
| `decay_weight` | `double precision NOT NULL DEFAULT 1.0` | Exponential recency weight |
| `recorded_at` | `timestamptz NOT NULL` | When the observation occurred |

> **Strict Truthfulness Invariant**: Telemetry ingestion uses `optionalNumber(value)`. Missing or unobserved metrics are stored and computed as `null`, **never** coerced to `0` via `Number(val) || 0`. Observed zeros (e.g. 0 shares recorded by the API) remain `0`. Null metrics do not contribute negative or positive evidence to Bayesian updates, outlier scores, or decile trait separation.

---

## 2. Exponential Recency Decay

Social media algorithms and advertising audiences fatigue over time. Meridian prevents stale historic campaigns from biasing current creative decisions by applying exponential time decay:

$$w(t) = \exp\left(-\frac{\ln(2) \cdot \Delta t}{t_{\text{half}}}\right)$$

- $\Delta t$: Age of the observation in days ($\text{now} - \text{recorded\_at}$).
- $t_{\text{half}}$: Observation half-life (default: **14 days** for social video).
- **At day 0**: $w = 1.0$ (full weight).
- **At day 14**: $w = 0.5$ (half weight).
- **At day 28**: $w = 0.25$ (quarter weight).

---

## 3. Bayesian Feature Posterior Updating

For each creative feature (e.g. hook archetype, creative angle), Meridian computes conjugate Beta posteriors:

$$\alpha_{\text{post}} = \alpha_0 + \sum_{i} w_i \cdot s_i$$
$$\beta_{\text{post}} = \beta_0 + \sum_{i} w_i \cdot (n_i - s_i)$$

Where:
- Prior $(\alpha_0, \beta_0)$: Weakly informative baseline prior derived from overall brand average performance (`baselinePrior(rate, strength = 10)`).
- $s_i$: Effective successes (e.g., $3\text{s views} = \text{views} \times \text{hook\_retention\_3s}$, or clicks, conversions).
- $n_i$: Effective trials (total views or impressions).
- $w_i$: Recency decay weight.

### Output Statistics
- **Posterior Mean**: $\frac{\alpha}{\alpha + \beta}$
- **90% Credible Interval**: Normal approximation $[\text{low}_{0.05}, \text{high}_{0.95}]$ computed via `betaInterval(post, 0.90)`.
- **Lift vs Baseline**: Percentage difference between posterior mean and baseline rate.
- **$P(\text{Beat Baseline})$**: Probability that the feature outperforms the average baseline, calculated analytically using `probabilityGreater(post, prior)`.

---

## 4. Closing the Cognitive Loop (Flywheel Sync)

When an operator clicks **"Sync to JEV Brain"** or the scheduled worker job `telemetry.sync` triggers:
1. Telemetry records are bridged into `performance_observations` and `organic_observations`.
2. Meridian re-evaluates brand-level pattern hypotheses and Benjamini-Hochberg FDR adjustments via `applyLearnedPatterns()`.
3. JEV Account Profiles (`jev_account_profiles`) are dynamically updated with:
   - Updated rolling average engagement rate.
   - Top-performing hook archetypes based on posterior hook retention.
4. Future Studio briefs and opportunity rankers automatically prioritize the newly validated hooks and angles while penalizing fatigued concepts.

---

## 5. Learning UI Dashboard

Located at `/brands/$brandId/learning`:
- **KPI Summary**: Total tracked views across all channels, decay-weighted 3s hook retention, completion rate, and platform breakdowns.
- **Hook Retention Posteriors Table**: Real-time table displaying sample count, effective views, posterior mean, 90% credible intervals, lift %, and probability of beating baseline.
- **Manual Ingest Drawer**: Quick-entry form allowing operators to log video views, retention rates, shares, and engagements directly into the flywheel.
- **Sync Trigger**: Instant synchronization with feedback showing synced rows and newly learned top hooks.
