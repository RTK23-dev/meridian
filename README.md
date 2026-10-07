# Meridian

> **Multi-Tenant Autonomous Creative Operating System**  
> Evidence-led advertising & organic content factory, JEV deterministic policy engine, Hypit video production, modular n8n-style flow pipelines, and closed-loop Bayesian learning.

[![CI](https://github.com/RTK23-dev/meridian/actions/workflows/ci.yml/badge.svg)](https://github.com/RTK23-dev/meridian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/Release-0.1.0--beta.4-emerald.svg)](CHANGELOG.md)

---

## Autonomous Closed-Loop Architecture

Meridian continuously analyzes evidence, generates video variants, enforces safety/originality policies, selectively distributes to paid and organic channels, and feeds verified telemetry back into Bayesian posteriors:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           MERIDIAN AUTONOMOUS FLYWHEEL                        │
└───────────────────────────────────────────────────────────────────────────────┘
                                       │
     1. DISCOVER                       ▼                       2. EVALUATE & GATE
 ┌──────────────────────┐    ┌────────────────────┐    ┌─────────────────────────┐
 │ Market Sources & DNA │───▶│ Opportunity Ranker │───▶│ JEV Deterministic Policy│
 │ Ad Library / Sensors │    │ Winner Score & DNA │    │ Originality & Claim QA  │
 └──────────────────────┘    └────────────────────┘    └─────────────────────────┘
                                                                    │
                                                                    ▼
     4. CLOSED-LOOP FLYWHEEL           5. DISTRIBUTE           3. PRODUCE
 ┌──────────────────────┐    ┌────────────────────┐    ┌─────────────────────────┐
 │ JEV Bayesian Learning│◀───│ Selective Channels │◀───│ Studio Production       │
 │ Decay-Weighted Stats │    │ Paid Ads & Organic │    │ Hypit & Timeline Engines│
 └──────────────────────┘    └────────────────────┘    └─────────────────────────┘
```

> **Core Invariant**: A provider or channel remains **NOT CONNECTED** until real credentials succeed. Meridian never invents ad accounts, delivery metrics, publish receipts, or connected states.

---

## Key Capabilities

### 1. Modular Engine & n8n-Style Flow Connectors
- **Decoupled Swappable Engines**: Cleanly separated contracts for `GradingEngine`, `PlannerEngine`, `PublishEngine`, `VideoEngine`, and `SourceAdapter`.
- **Chainable Pipelines**: Connect engines with standardized `FlowNode` contracts and `createFlow("pipeline-id")` runners (identical to n8n node graphs).
- **Extensible Registry**: Register custom video renderers or ad networks without modifying core routing or database schemas.

### 2. Multi-Channel Selective Distribution
- **Paid Advertising**: Paused campaign staging for **Meta Ads**, **TikTok Ads**, and **Google Ads**.
- **Organic Social**: Native connectors for **Instagram Reels**, **Facebook Pages**, and **YouTube Shorts**.
- **Per-Channel Targeting**: Interactive modal lets operators selectively pick which channels receive paid test spend vs. organic distribution for each creative variant.

### 3. Creative DNA v2 & Content Factory
- **Multimodal Video Decomposition**: `ffmpeg` scene detection, keyframe vision analysis, OCR text role classification, and WhisperX timestamp alignment.
- **pgvector Semantic Retrieval**: 384-dimensional embeddings stored in Postgres with cosine similarity index (`migrations/0019_creative_dna_pgvector.sql`).
- **Originality & Claim Gates**: 64-bit perceptual hashing with Hamming distance checks block copycat variants. Claims missing proof stay in human review.

### 4. Advanced JEV & Bayesian Learning Flywheel
- **Multi-Objective Telemetry**: Ingests both paid performance (CTR, CVR, ROAS) and organic engagement (3s hook retention, completion rate, shares).
- **Exponential Recency-Decay Weighting**: Half-life decay ensures fresh performance informs new briefs without being skewed by months-old ad campaigns.
- **Hierarchical Cold-Start Priors**: Smoothly regularizes new brands using vertical category baselines while preserving strict multi-tenant isolation.
- **Benjamini-Hochberg FDR Control**: False-discovery rate filtering weeds out random statistical noise.

---

## Quick Start

### Prerequisites
- Node.js 22+
- PostgreSQL 16+ with `pgvector` (or embedded PGlite for local preview)
- FFmpeg & FFprobe (optional for mock tests, required for real video analysis)

### 1. Installation
```bash
git clone https://github.com/RTK23-dev/meridian.git
cd meridian
npm install
cp .env.example .env
```

### 2. Database Setup
```bash
# Set your DATABASE_URL in .env, then apply migrations:
npm run db:migrate

# Or launch local embedded PGlite server:
npm run db:local
```

### 3. Run Applications
```bash
# Terminal 1: Web Interface & API (http://localhost:8080)
npm run dev

# Terminal 2: Background Job Worker
npm run worker

# Terminal 3: Periodic Job Scheduler
npm run scheduler
```

---

## Quality Gates & Verification

Every pull request and release is validated across rigorous automated test suites:

```bash
# Run 326+ automated tests across 16 test suites
npm test

# Verify strict TypeScript types (0 errors)
npm run typecheck

# Verify ESLint code quality (0 errors, 0 warnings)
npm run lint

# Compile production bundle with Nitro & PGlite assets
npm run build
```

---

## Configuration & Environment Variables

| Variable | Purpose | Default / Requirement |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | PGlite embedded if unset |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for tenant tokens | Required for OAuth tokens |
| `OPENROUTER_API_KEY` | Model gateway for JEV decisions | Required for model evaluations |
| `HYPIT_BASE_URL` | Hypit 0.2.17 video generation service | Reports `HYPIT_NOT_CONNECTED` if unset |
| `META_ACCESS_TOKEN` | Meta Graph API access token | Meta publishing stays paused |
| `TIKTOK_ACCESS_TOKEN` | TikTok Marketing API access token | TikTok publishing stays disabled |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API developer token | Google client stays disconnected |
| `S3_ENDPOINT` / `S3_BUCKET` | S3-compatible object storage | Local filesystem used if unset |

---

## Project Layout

```
meridian/
├── src/
│   ├── routes/              # TanStack Start file-based screens
│   ├── components/          # Reusable UI & design system (WCAG 2.2 AA)
│   └── lib/
│       ├── meridian/
│       │   ├── distribution/ # Multi-channel paid & organic connectors
│       │   ├── factory/      # Creative DNA v2, trends & source adapters
│       │   ├── flow/         # Modular n8n-style flow connector pipeline
│       │   ├── grading/      # Winner score & heuristic grading engines
│       │   ├── jev/          # Deterministic questions, policy & judgments
│       │   ├── learning/     # Bayesian engine, decay weights & store
│       │   ├── stats/        # Beta-binomial math & FDR control
│       │   └── video/        # Hypit & timeline multi-aspect video engines
├── migrations/              # SQL migrations applied in chronological order
├── docs/                    # Architecture, setup, JEV, and gap analysis
└── scripts/                 # Worker, scheduler, and smoke automation
```

---

## Documentation Index

- [Local & Production Setup Guide](docs/SETUP.md)
- [System Architecture & Flow Design](docs/ARCHITECTURE.md)
- [Content Factory & Creative DNA](docs/FACTORY.md)
- [JEV Deterministic Policy & Learning](docs/JEV.md)
- [Accessibility (WCAG 2.2 AA) Standards](docs/ACCESSIBILITY.md)
- [Provider Integrations & Security](docs/PROVIDERS.md)
- [Product Gap Analysis & Roadmap](docs/PRODUCT_GAP_ANALYSIS.md)

---

## License

Licensed under the [MIT License](LICENSE). Original code.
