# Meridian

> **Multi-Tenant Advertising Operating System**  
> Evidence-led creative intelligence, deterministic policy gating, multimodal production routing, durable budget controls, and closed-loop telemetry learning. Built on TanStack Start, React 19, Tailwind v4, and PostgreSQL.

[![CI](https://github.com/RTK23-dev/meridian/actions/workflows/ci.yml/badge.svg)](https://github.com/RTK23-dev/meridian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/Release-0.1.0--beta.10-emerald.svg)](CHANGELOG.md)

---

## Overview

Meridian automates the end-to-end advertising lifecycle with strict architectural guarantees:

```text
Research & Discovery (Durable Frontier Leased)
  ↓
Normalized Evidence (Tenant-Scoped)
  ↓
JEV Policy Gate (Deterministic Evaluation & Claims QA)
  ↓
Creative Plan (State Machine: Draft → Approved)
  ↓
Budget Ledger (Atomic Micro-Unit Reservation)
  ↓
Creative Manifest (Deterministic Projection from Plan)
  ↓
Production Router (Gemini Omni, Image, Higgsfield, Hypit, Manual)
  ↓
Artifact Finalizer (Byte-Hash Verification & Fail-Closed MIME)
  ↓
Postflight QC
  ↓
Publishing & Performance Telemetry
  ↓
Learning Flywheel (Bayesian Priors & Recency Weighting)
```

---

## Core Guarantees

1. **Truthful States & No Invented Data**  
   Meridian never fabricates ad accounts, performance metrics, publish receipts, or connected states. Unconfigured services visibly stay `NOT CONNECTED`. Missing metrics remain `null`, never coerced into synthetic zeros.

2. **Deterministic Policy Evaluation (JEV)**  
   Semantic decisions run through TypeSafe Decisions API and OpenRouter with strict evidence requirements. Missing evidence triggers an explicit abstention (`abstain_insufficient_evidence`) rather than hallucinated approvals. No generic chat fallback is ever used for decision gates.

3. **Durable Budget Ledger & Concurrency Safety**  
   Financial operations use integer micro-units (`1 USD = 1,000,000 micros`, `bigint`) to eliminate floating-point drift. Budget reservations are atomic conditional database updates. A two-phase lifecycle (`RESERVE` → `RECONCILE` / `RELEASE`) guarantees budget caps are strictly enforced even under concurrent executions.

4. **Byte-Verified Storage & Artifact Integrity**  
   All rendered artifacts undergo magic-byte signature inspection (PNG, JPEG, MP4, WebM) and a post-upload SHA-256 round-trip verification. If bytes cannot be safely persisted and verified from storage, jobs fail closed (`STORAGE_PERSISTENCE_FAILED`).

5. **Durable Discovery Frontier**  
   Crawling and discovery queues are backed by PostgreSQL using atomic `SELECT ... FOR UPDATE SKIP LOCKED` leases, heartbeat renewal, and automated recovery of stale or interrupted work across restarts.

6. **Tenant Isolation & Security**  
   Role checks (`hasRole`) protect every mutation, and strict tenant isolation protects every server function. Provider API keys are encrypted at rest with AES-256-GCM in the credential vault with SSRF screening on all outbound network requests.

---

## Quick Start

### Prerequisites
- **Node.js 22+**
- **PostgreSQL 16+** (or embedded PGlite for local testing)
- **FFmpeg & FFprobe** (optional for local testing, required for real video processing)

### 1. Installation
```bash
git clone https://github.com/RTK23-dev/meridian.git
cd meridian
npm ci
cp .env.example .env
```

### 2. Database Migration
```bash
# Migrates database when DATABASE_URL is set in .env
# (PGlite embedded database migrates automatically when DATABASE_URL is unset)
npm run db:migrate
```

### 3. Running Services
```bash
# Terminal 1: Web Application (http://localhost:8080)
npm run dev

# Terminal 2: Background Job Worker
npm run worker

# Terminal 3: Periodic Scheduler
npm run scheduler
```

---

## Quality Gates & Verification

Every merge and release candidate must pass all four quality gates:

```bash
# 1. Run all unit and integration test suites (590+ tests)
npm test

# 2. Strict TypeScript type check
npm run typecheck

# 3. Linting rules
npm run lint

# 4. Production build verification
npm run build
```

---

## Configuration

Configure environment variables in `.env`:

| Variable | Description | Default / Fallback |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | PGlite embedded if unset |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM 32-byte hex key for vault | Required for credential vault |
| `MERIDIAN_JEV_PROVIDER` | JEV provider (`typesafe_direct` or `openrouter`) | `typesafe_direct` |
| `TYPESAFE_JEV_API_KEY` | TypeSafe Decisions API key | Falls back to OpenRouter if unset |
| `OPENROUTER_API_KEY` | OpenRouter API key | Required for OpenRouter route |
| `MERIDIAN_GEMINI_API_KEY`| Google AI Studio key for Gemini Omni / Veo | Required for Gemini production |
| `HIGGSFIELD_API_KEY` | Higgsfield AI video generation key | Required for Higgsfield models |
| `GOOGLE_DRIVE_FOLDER_ID`| Root Google Drive folder ID for object storage | Required for Drive store |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account credentials JSON | Required for Drive store |
| `HYPIT_BASE_URL` | Local Hypit video assembly bridge URL | `HYPIT_NOT_CONNECTED` if unset |

---

## Documentation

- [Setup Guide](docs/SETUP.md) — Local development and production deployment.
- [Architecture](docs/ARCHITECTURE.md) — System design, data flow, and module boundaries.
- [JEV Policy Engine](docs/JEV.md) — Deterministic decision evaluation and rubrics.
- [Content Factory](docs/FACTORY.md) — Creative planning, generation pipeline, and quality gates.
- [Providers](docs/PROVIDERS.md) — Video, image, and publishing provider integrations.
- [Telemetry Flywheel](docs/TELEMETRY_FLYWHEEL.md) — Closed-loop learning and performance feedback.
- [Credential Vault](docs/VAULT_AND_ACCOUNTS.md) — Encryption and provider account management.
- [Database Schema](docs/DATABASE.md) — PostgreSQL table schemas and migration order.
- [Operator Guide](docs/OPERATOR_GUIDE.md) — Operational runbook for production operators.
- [Accessibility](docs/ACCESSIBILITY.md) — What the interface does for keyboard, screen-reader and touch users, and what is not yet verified.

---

## License

Licensed under the [MIT License](LICENSE).
