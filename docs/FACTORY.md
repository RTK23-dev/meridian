# Content Factory

Meridian reuses structure, pacing, hook type, and shot style. It does **not** reuse footage, music, characters, slogans, or a competitor's look. Deterministic gates enforce that.

## Pipeline Loop

```
Discover → Ingest (Swipe / Sensor Tower) → Decode (Creative DNA v2) → Winner Score
  → pgvector Trends Clustering → Pick → Template → Multi-Aspect Production
  → Originality & Policy Gates → Review → Paused Launch → Capped Tests → Learn
```

Each stage runs as a durable SQL job (`factory.*`) with an idempotency key, exponential backoff, and tenant-scoped queues.

---

## The 6 Build Steps

### Step 1: Base & Invariant Isolation
- Pre-installs WhisperX and HuggingFace models at build time in `Dockerfile.worker`.
- Domain modules split cleanly into single-responsibility units without behavior change.
- Strict tenancy, auth role checks, and fail-closed boot invariants when `DATABASE_URL` is unset in production.

### Step 2: Creative DNA v2, Canonical Structure & pgvector
- **Real Video Decoder (`decode.ts`)**:
  - `ffmpeg` scene-cut detection with timestamped intervals.
  - Keyframe extraction per detected scene.
  - Vision model scene labeling (`shotType`, `presenter`, `setting`, `motion`, `overlay`, `productOnScreen`).
  - OCR text extraction with rule-based text role classification (`classifyTextRole`: hook, claim, proof, offer, cta).
  - WhisperX word-level transcript alignment to scenes.
  - **Canonical Creative Structure (`creative-dna.ts`)**:
    - Classifies organic content across 13 canonical formats (`organic_short`, `pov`, `skit`, `storytime`, `listicle`, `tutorial`, `reaction`, `trend_audio`, `transformation`, `review`, `comparison`, `loop`, `unstructured`).
    - Candidates evaluated deterministically (`classifyCreativeStructureCandidate`, `evaluateCreativeStructureCandidates`).
    - `AdNarrative` (hook, problem, reveal, proof, offer, cta) is an optional projection for paid ads; organic short-form reels/videos are not forced into 6-beat ad schemas.
    - Fallback heuristic transcript extraction renamed to `dnaFromAdTranscriptFallback` with explicit `legacyAdFallback: true` marking.
- **Strict Epistemic Type Separation**:
  - Distinguishes observed probability, confidence, modelQualityEstimate, heuristicScore, and evidenceState across all CreativeSegment and DNA fields.
- **384-dimensional Multimodal Embeddings**:
  - Stored in Postgres using `pgvector` via `migrations/0019_creative_dna_pgvector.sql`.
  - Source frame and timestamp provenance for every attribute. Missing evidence stays `"missing"`, never guessed.

### Step 3: Sources & Winner Score Backtesting
- **Source Adapters (`sources.ts`)**:
  - `BulkUploadSourceAdapter`: Local folder and CSV links for first-party / swipe files.
  - `SensorTowerSourceAdapter`: Licensed ad-intelligence integration for competitor video discovery (reports `NOT_CONNECTED` when `SENSOR_TOWER_API_KEY` is unset).
- **Winner Score (`winner-score.ts`)**:
  - Transparent components: survival duration, iteration velocity, country/platform spread, advertiser track record, and creative quality.
  - Daily timeline re-check job (`recheckAdTimelines`).
  - `runWinnerScoreBacktest`: Measures top 20% hit rate against 30+ day longevity, reporting calibration lift across tracked ads.

### Step 4: Trends Clustering
- **pgvector Vector Clustering (`trends.ts`)**:
  - Cosine-similarity clustering over Creative DNA multimodal embeddings.
  - Momentum tracking (`rising`, `peaking`, `fading`) calculated strictly from real week-over-week counts and advertiser metrics.

### Step 5: Multi-Aspect Production & Originality Gates
- **Multi-Aspect Timeline Renderer (`render.ts`)**:
  - Assembles timeline compositions across `9:16`, `4:5`, `1:1`, and `16:9` aspect ratios.
  - Second `VideoEngine` adapter (`timelineVideoEngine` alongside `hypitVideoEngine`).
  - Permutational variant matrix (`variantMatrix`) exploring hooks × angles × CTAs.
- **Originality Gate (`gates.ts`)**:
  - 64-bit Perceptual Hashing (pHash) with Hamming distance verification.
  - Embedding cosine distance comparison against source swipe frames.
  - Blocks close copies (`Hamming distance < 8` or `Cosine similarity > 0.92`), passes novel variants, and routes missing frame evidence to human review.

### Step 6: Go Live & Autopilot Gating
- **Autopilot Levels 0–3 (`autopilot.ts`)**:
  - **Level 0 (Suggest)**: Discovers trends and proposes templates.
  - **Level 1 (Produce)**: Generates variants and runs gates for human review.
  - **Level 2 (Stage)**: Uploads approved variants as paused campaigns.
  - **Level 3 (Run)**: Manages active budgets within owner-set daily and total caps.
- **Verified Meta Test-Account Gate (`checkMetaRoundTripReceipt`)**:
  - Staging and live execution (levels 2–3) remain strictly disabled until a verified Meta round trip is recorded:
    1. Stored Hypit MP4 upload confirmed on Meta.
    2. Paused campaign/ad set creation receipt.
    3. Synced performance observations.
  - Missing evidence refuses activation with explicit diagnostic reasons.

---

## Modular Engines & Flow Connectors (n8n-Style)

Meridian is architected as swappable, decoupled engines rather than a monolithic machine:

| Engine | Interface | Built-in Adapters |
|---|---|---|
| **Grading Engine** | `GradingEngine` | `winnerScoreGradingEngine`, `heuristicGradingEngine` |
| **Planner Engine** | `PlannerEngine` | `matrixPlannerEngine` |
| **Publish Engine** | `PublishEngine` | `metaPublishEngine`, `testPublishEngine` |
| **Video Engine** | `VideoEngine` | `hypitVideoEngine`, `timelineVideoEngine` |
| **Source Engine** | `SourceAdapter` | `BulkUploadSourceAdapter`, `SensorTowerSourceAdapter` |

### Flow Pipelines (`flow/connector.ts`, `flow/nodes.ts`)
Compose nodes into executable pipelines:

```ts
import { createFlow } from "@/lib/meridian/flow/connector";
import {
  createSourceNode,
  createGradingNode,
  createPlannerNode,
  createGateNode,
  createPublishNode,
} from "@/lib/meridian/flow/nodes";

const flow = createFlow("brand-campaign-flow")
  .pipe(createSourceNode(sourceAdapter))
  .pipe(createGradingNode(gradingEngine))
  .pipe(createPlannerNode(plannerEngine))
  .pipe(createGateNode({ maxHammingDistance: 8 }))
  .pipe(createPublishNode(publishEngine));

const report = await flow.run(input, context);
```

---

### Step 7: Multi-Channel Distribution & Organic Telemetry

The distribution engine (`src/lib/meridian/distribution/`) handles dual-track publication:
- **Paid Ad Staging**: Meta Ads, TikTok Ads, Google Ads (staged strictly in PAUSED mode until manually verified).
- **Organic Social Posting**: Instagram Reels, Facebook Pages, YouTube Shorts (via native connectors under `channel_connections`).
- **Telemetry Ingestion**: Gathers 3s hook retention, video completion rates, and shares, feeding back into JEV Bayesian posteriors with exponential recency-decay weighting (`decay.test.ts`).

---

## Universal Source Fabric & Dynamic Creative Structures

1. **Universal Source Fabric (`src/lib/meridian/sources/`)**:
   - Universal capability contracts supporting Instagram, TikTok, YouTube Shorts, Meta Ad Library, web pages, search queries, user uploads, and first-party performance telemetry.
   - 5-layer deduplication (exact SHA-256, perceptual hash, audio fingerprint, canonical URL, text embedding).
2. **Primary Storage**:
   - **Google Drive** is the primary binary object store (`storage_objects` metadata in Postgres).
   - Manages tenant hierarchy (`tenants/<orgId>/brands/<brandId>/...`).
   - S3 remains only as a legacy fallback.
3. **Dynamic Creative Structures**:
   - Short-form content uses `CreativeStructure` with dynamic discovered segments (`CreativeSegment`), rather than enforcing rigid 6-beat ad narrative templates.
   - Narrative beats remain available as an optional specialization.
4. **Provider-Neutral Production & ManualCloud Mode**:
   - Cost-aware routing (`ZERO_SPEND`, `LOWEST_COST`, `BALANCED`, `QUALITY_FIRST`).
   - `ManualCloudProvider`: Drop-folder workflow in Google Drive (`production/inputs/<jobId>/` and `production/outputs/<jobId>/`) with $0 rendering spend.
   - Preflight and Postflight QC gates prevent premature spend and catch defective artifacts before distribution.

---

## Factory Line Process & Component Customization (Native Modular Pipeline)

Meridian provides an integrated, code-driven visual pipeline for the Content Factory without relying on external automation tools like n8n. All configuration is stored natively in PostgreSQL (`factory_pipeline_configs`), typed in TypeScript (`src/lib/meridian/factory/pipeline-config.ts`), and editable via the React UI (`src/components/factory/pipeline-editor.tsx`).

### Core Features

1. **Interactive Conveyor Flow**:
   - Visual representation of all 9 stages: Discovery, Perception Decoding, JEV Cognitive Grading, Brief Synthesis, Scriptwriting, Rendering, QC Gating, Studio Review, and Distribution Dispatch.
   - Operators can toggle or bypass individual stages with one click.
   - Stage drawers expose active inputs, outputs, models, and latency metrics.

2. **System Prompt Customization**:
   - Operators can edit prompts live with character counters:
     - **Creative Director Brief Prompt**: Guides angle synthesis and psychological hook transfer without copying competitor copy.
     - **Script & Monologue Prompt**: Enforces pacing, hook structure (0–3s), and spoken word cadence (140–180 WPM).
     - **Multimodal Perception Prompt**: Calibrates scene cut detection, visual style classification, and prosody extraction.
     - **JEV Cognitive Grading Prompt**: Sets deterministic rubric standards for claim safety and transferability.

3. **Video Output Volume & Engine Controls**:
   - **Video Count**: Configurable from 1 to 10 variations per winning concept.
   - **Aspect Ratios**: Multi-ratio selection (`9:16`, `1:1`, `16:9`, `4:5`).
   - **Pacing & Duration**: Target duration (15s, 30s, 45s, 60s, up to 120s) and cut pacing classification (`hyper_fast`, `cinematic`, `steady`, `dynamic`).
   - **Rendering Engine**: Selection between `manual_cloud` ($0 spend Drive drop), `hypit` (autonomous video synthesis), `veo`, and `higgsfield`.

4. **Winner Grading Levels**:
   - **Winner Score Floor**: Minimum threshold (50%–99%) for an idea to be considered a winning concept.
   - **Bayesian $P(\text{beat})$ Floor**: Minimum confidence (50%–99%) that the variant outperforms historical baseline.
   - **3s Retention Floor**: Minimum 3-second hook retention threshold (10%–90%).
   - **Auto-Approve Gate**: When enabled, high-confidence winning concepts pass directly to production; otherwise, routed to human review.
   - **Strict Claim Gate**: Deterministically rejects unbacked claims.

5. **Curated Presets**:
   - `viral_ugc`: 5 videos, 9:16 vertical, hyper-fast pacing, 70% winner score bar.
   - `problem_solution`: 3 videos, 30s duration, steady pacing, structured transformation rubric.
   - `strict_quality`: Conservative bar (85% score floor, 90% $P(\text{beat})$ confidence), human review mandatory.
   - `manual_cloud`: $0 spend workflow exporting shot lists directly to Google Drive.


