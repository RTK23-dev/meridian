# Meridian

> **Multi-Tenant Autonomous Creative Operating System**  
> Evidence-led advertising & organic content factory, JEV deterministic policy engine, multimodal video production, modular flow pipelines, and closed-loop Bayesian learning.

[![CI](https://github.com/RTK23-dev/meridian/actions/workflows/ci.yml/badge.svg)](https://github.com/RTK23-dev/meridian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/Release-0.1.0--beta.8-emerald.svg)](CHANGELOG.md)

---

## Autonomous Closed-Loop Architecture

Meridian continuously harvests evidence, analyzes high-performing creative divergence, gates variants through deterministic policies, produces videos across AI rendering engines, distributes to paid and organic channels, and feeds verified telemetry back into Bayesian posteriors:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           MERIDIAN AUTONOMOUS FLYWHEEL                        │
└───────────────────────────────────────────────────────────────────────────────┘
                                       │
     1. DISCOVER                       ▼                       2. STUDY & GATE
 ┌──────────────────────┐    ┌────────────────────┐    ┌─────────────────────────┐
 │ Research Frontier    │───▶│ Deep Study Contrast│───▶│ JEV Decision Gates      │
 │ Crawl Ladder / Meta  │    │ 11D Angle Bible    │    │ Claim QA & Originality  │
 └──────────────────────┘    └────────────────────┘    └─────────────────────────┘
                                                                    │
                                                                    ▼
     5. CONTINUOUS LEARNING            4. DISTRIBUTE           3. PRODUCE
 ┌──────────────────────┐    ┌────────────────────┐    ┌─────────────────────────┐
 │ Bayesian Posteriors  │◀───│ Selective Channels │◀───│ ProductionRouter        │
 │ Recency-Decay Weights│    │ Paid Ads & Organic │    │ Gemini Omni / Veo / ... │
 └──────────────────────┘    └────────────────────┘    └─────────────────────────┘
```

> **Core Invariant**: A provider or channel remains **NOT CONNECTED** until real credentials succeed. Meridian never invents ad accounts, delivery metrics, publish receipts, or connected states. Missing data is stored as `null`, never defaulted to synthetic zeros or fabricated certainty.

---

## Core Capabilities

### 1. JEV Deterministic Decision Engine & Dual Router
- **Native System One Primitives**: Executes structured decisions using TypeSafe's native primitives:
  - `choice`: Discrete classification with probability distributions.
  - `noul`: Direct probabilistic necessity gate ($P \in [0, 1]$) with no fabricated confidence.
  - `score`: Ordered rubric evaluation against explicit criteria.
- **Dual Provider Routing**: `JevProviderRouter` supports direct TypeSafe AI (`typesafe_direct`) and OpenRouter Decisions API (`openrouter` with `typesafe/jev-1.13`) across `AUTO`, `TYPESAFE_DIRECT`, `OPENROUTER`, and `COMPARE` modes.
- **Fail-Closed & Evidence Sufficiency**: Requires observed evidence declared in `evidenceRequirements`. If evidence is missing, JEV returns `abstain_insufficient_evidence` and halts rather than hallucinating answers. Never falls back to generic chat completions.
- **Provenance Inspection**: The interactive `WhyThisDrawer` inspects question versions, model provenance, evidence references, and calibration lineage for any judgment.

### 2. Workspace Provider Configuration & Vault
- **Encrypted Credential Storage**: All provider API keys and tokens are encrypted at rest with AES-256-GCM in the workspace vault (`credential_vault`).
- **Zero Secrets Leaked**: The UI returns only masked key fingerprints (`...1234`), never raw tokens.
- **SSRF Prevention**: All configurable endpoints (e.g. Cyclone Gateway, custom proxy URLs) are validated through strict SSRF address screening (`publicUrlIssue`) before any network probe.
- **Interactive UI**: Manage credentials and operational parameters directly in the web app under **Settings → Provider Integrations** (`/settings`).

### 3. Research Frontier & Public Crawl Ladder
- **Budgeted Crawl Ladder**: Safe, multi-step public crawler (`crawlLadderPage`):
  1. SSRF destination screening.
  2. Public HTTP fetch with size boundaries.
  3. Structured OpenGraph, JSON-LD, and page metadata extraction.
  4. Heuristic repeated content card detection (`<article>`, `.card`, `.post`).
  5. Same-host outbound link discovery.
- **Honest Metrics**: Cards without visible performance explicitly store `{ value: null, state: "UNAVAILABLE" }`, preventing fabricated vanity metrics.

### 4. Deep Study, Contrast Engine & Concept Library
- **Outlier vs. Baseline Contrast**: `DeepStudyContrastEngine` analyzes viral breakout reels against baseline controls to identify the causal drivers of engagement:
  - Hook divergence and pattern interrupt mechanisms.
  - Cut pacing and audio prosody.
  - Comment objection and intent mining.
- **11D Angle Bible & Concept Genome**: Maps observed mechanisms into the versioned 11D Angle Bible framework, generating structured `ConceptGenome` entities.
- **Four Distinct Opportunity Targets**:
  1. *Observed Breakout Score* (empirical lift over creator baseline).
  2. *Creative Concept Strength* (Angle Bible dimension weights).
  3. *Transfer Potential* (brand and product fit).
  4. *Business Potential* (conversion and ROAS telemetry).

### 5. ProductionRouter & Generative Video
- **Unified Creative Execution**: Production compiles to canonical `CreativeSpec` objects, routed across configured providers:
  - **Google Gemini Omni Flash**: Generative video editing and text/image-to-video via official Interactions API.
  - **Google Veo**: Stable GA video models (`veo-2.0-generate-001`).
  - **Higgsfield AI**: Camera-directed generative video.
  - **Hypit Engine**: Local multi-track UGC video assembly bridge.
  - **ManualCloud (Zero Spend)**: Generates production manifests and drop-folder structures for manual editing workflows.
- **Durable Job Poller**: Claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED` and verifies postflight quality control.

### 6. Closed-Loop Bayesian Learning Flywheel
- **Empirical Beta Posteriors**: Tracks winning formulas using conjugate Beta-binomial distributions from verified ad and organic telemetry.
- **Exponential Recency-Decay**: 14-day half-life ensures recent performance informs upcoming briefs without historical campaign distortion.
- **Hierarchical Cold-Start Priors**: Regularizes new brands using category baselines without compromising multi-tenant privacy.
- **FDR Control**: Benjamini-Hochberg false-discovery rate filtering eliminates statistical anomalies.

---

## Quick Start

### Prerequisites
- Node.js 22+
- PostgreSQL 16+ (or local embedded PGlite for evaluation)
- FFmpeg & FFprobe (optional for tests, required for real media processing)

### 1. Installation
```bash
git clone https://github.com/RTK23-dev/meridian.git
cd meridian
npm install
cp .env.example .env
```

### 2. Database Setup
```bash
# Set DATABASE_URL in .env, then apply migrations:
npm run db:migrate

# Or launch local embedded PGlite database:
npm run db:local
```

### 3. Run Applications
```bash
# Terminal 1: Web Interface & Server Functions (http://localhost:8080)
npm run dev

# Terminal 2: Background Job Worker
npm run worker

# Terminal 3: Periodic Scheduler
npm run scheduler
```

---

## Quality Gates & Verification

All releases enforce complete verification before merge:

```bash
# Run 523 automated tests across 16 test suites (including 35 Historical Regressions)
npm test

# Verify strict TypeScript compilation (0 errors)
npm run typecheck

# Verify ESLint standards (0 errors, 0 warnings)
npm run lint

# Compile production bundle with Nitro & PGlite assets
npm run build
```

---

## Configuration & Environment Variables

| Variable | Description | Default / Fallback |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | PGlite embedded if unset |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM encryption key for vault | Required for credential vault |
| `MERIDIAN_JEV_PROVIDER` | JEV provider (`typesafe_direct` or `openrouter`) | `typesafe_direct` |
| `TYPESAFE_JEV_API_KEY` | Direct TypeSafe Decisions API key | Falls back to OpenRouter if unset |
| `OPENROUTER_API_KEY` | OpenRouter gateway key for JEV and Research | Required for OpenRouter route |
| `MERIDIAN_GEMINI_API_KEY` | Google AI Studio key for Gemini Omni / Veo | Required for Gemini production |
| `HIGGSFIELD_API_KEY` | Higgsfield AI video generation key | Required for Higgsfield models |
| `GOOGLE_DRIVE_FOLDER_ID` | Root Google Drive folder for media storage | Required for Drive store |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Service Account credentials | Required for Drive store |
| `HYPIT_BASE_URL` | Hypit local HTTP bridge URL | `HYPIT_NOT_CONNECTED` if unset |

---

## Documentation Index

- [Local & Production Setup Guide](docs/SETUP.md)
- [System Architecture & Design](docs/ARCHITECTURE.md)
- [JEV Deterministic Policy & Decisions](docs/JEV.md)
- [Content Factory & Creative DNA](docs/FACTORY.md)
- [Telemetry & Bayesian Flywheel](docs/TELEMETRY_FLYWHEEL.md)
- [Vault & Credential Security](docs/VAULT_AND_ACCOUNTS.md)
- [Provider Integrations & Setup](docs/PROVIDERS.md)
- [Publishing Orchestration](docs/PUBLISHING_ORCHESTRATION.md)
- [Accessibility Standards (WCAG 2.2 AA)](docs/ACCESSIBILITY.md)

---

## License

Licensed under the [MIT License](LICENSE).
