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

### Step 2: Creative DNA v2 & pgvector
- **Real Video Decoder (`decode.ts`)**:
  - `ffmpeg` scene-cut detection with timestamped intervals.
  - Keyframe extraction per detected scene.
  - Vision model scene labeling (`shotType`, `presenter`, `setting`, `motion`, `overlay`, `productOnScreen`).
  - OCR text extraction with rule-based text role classification (`classifyTextRole`: hook, claim, proof, offer, cta).
  - WhisperX word-level transcript alignment to scenes.
  - 6-beat sequence mapping (`hook`, `problem`, `reveal`, `proof`, `offer`, `cta`).
- **384-dimensional Multimodal Embeddings**:
  - Stored in Postgres using `pgvector` via `migrations/0019_creative_dna_pgvector.sql`.
  - Full confidence scoring and source frame/timestamp provenance for every attribute. Missing evidence stays `"missing"`, never guessed.

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
