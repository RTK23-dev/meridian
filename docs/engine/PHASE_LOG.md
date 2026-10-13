# Video engine phase log

Kept by the lead. One entry per event: setup, merge, phase gate, decision.

## 2026-10-13 Setup (awaiting owner approval)

- Added `docs/engine/VIDEO_ENGINE_BIBLE.md` and `docs/engine/MERIDIAN_HANDOFF.md` from the owner's uploads.
- Added `.claude/skills/engine-bible/SKILL.md`: Bible sections 0, 1, 4, 5 and 17, verbatim.
- Added five agents in `.claude/agents/`: eng-contracts (W1, W12), eng-pipeline (W2, W3, W14), eng-media-assets (W4, W5, W6), eng-edit-compose (W8, W9, W10), eng-plan-review (W7, W11, W13).
- Added the engine working rules and known conflicts to `CLAUDE.md`.
- No engine code written. Phase E1 not started.

Open before E1: the four conflicts listed in `CLAUDE.md`, and the Bible section 20.2 questions (speech-to-text vendor is needed in E1).

## 2026-10-13 Owner approved the run; E1 started

Run plan:
- Wave A: eng-contracts alone (W1 contracts and config, W12 budget logic). The lead reviews and merges before wave B.
- Wave B, in parallel on fixtures: eng-pipeline (W2 migration, registry, orchestrator, poller, artifact and ledger stores), eng-media-assets (W4 ffmpeg functions and clients, speech-to-text interface), eng-edit-compose (W9 compiler and five components, W10 HyperFrames cloud adapter), eng-plan-review (W7 decision steps 1 to 4, W11 pre-production and render-integrity gates).
- W3 (Claude client), W5 (asset router) and W8 (editor) wait for E2 and E3.

Lead decisions on gaps in Bible section 4 (contracts that the Bible names but does not define):
- `AssetSpec`, `ValidatedRequest`, `BudgetReservation`, `Composition` and `ReviewResult` are defined by eng-contracts to the shapes given in its task, and added to Bible section 4 as v1.
- Section 13 kit types and the section 10.1 adapter types also live in `src/engine/contracts/`.
- Artifact metadata (`artifactId`, `contentHash`, `parentIds`, `createdAt`) sits in one `ArtifactEnvelope`, not repeated in every type.

Interim handling of open conflicts (owner may overrule):
- Storage: engine code uses a storage interface backed by Meridian's existing object store. No S3 code is added.
- Speech-to-text: interface plus a recorded-response fixture adapter; no vendor chosen.
- Phase 0 prerequisite: E1 proceeds on fixtures; E1 acceptance still needs the owner's live run.
