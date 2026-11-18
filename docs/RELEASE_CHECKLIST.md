# Release checklist: from beta to stable

The current version is 1.1.0. **The owner released it as stable on 2026-11-18 with the live gates below still open** (decision recorded in docs/decisions/DECISIONS_2026-11-18.md). Each open box is closed when its live run is recorded, with ids and costs. The gates below are for the stable label only: a pre-release goes out with the open ones listed in its notes. These gates must all be recorded before the label changes. A gate is recorded by writing the date, the commit, and the evidence (ids, costs, output) under it. A fixture result never counts for a live gate.

## Done (fixtures and recorded data)

- [x] Product gate, in code: the Batch page opens on Video batches with five plain steps; Setup has two required steps and one list of optional rows.
- [x] Fixture gate: a research format, a bounded batch of draft videos, a labelled demo review (approve, reject with a reason) and a CSV summary, all covered by PGlite tests and browser acceptance (G12 to G15).
- [x] Safety gate, in code: a request with no budget, no reference, no Market evidence or a scripted source writes nothing and starts nothing. Creating drafts makes no engine request and no provider call.
- [x] Deployment check: `npm run check:deployment` and the checklist in `docs/OPERATIONS.md`.

## Open (cannot be closed without owner-authorized keys and a person)

- [ ] **Deployment:** the app, worker and scheduler run against a real PostgreSQL 16 with pgvector, with `npm run check:deployment` clean.
- [ ] **File store:** Google Drive is configured, and a real reference video uploads and is read back by the engine.
- [ ] **Live analysis:** one real reference is analyzed; its research patterns are written from real analyses.
- [ ] **Live render:** one real video is rendered end to end, then a batch of three. Record the request ids, provider and model, output artifact ids, and the actual cost against the estimate.
- [ ] **Review and export:** a delivered video is played, approved and exported; its rights record is valid.
- [ ] **Owner walkthrough:** someone who did not build this completes the first-run task (brand, engine, research, draft, variations, start, review) and writes down where they hesitated. Fix what they hit.
- [ ] **Output check:** the owner looks at the videos and confirms they are close enough to what they wanted.
- [ ] **CI:** every job is green on the release commit.

## Added since 1.1.0-beta.1 (open, need a live run)

- [ ] **Claude Code runner:** one video made by `npm run claude:runner` with the real Claude Code CLI, saved and marked Done; the job log kept.
- [ ] **Create with a key:** one script run with an OpenRouter key, from a new workspace, timed.
- [ ] **Email:** one invitation and one password-reset email delivered; the invitation accepted from its link.
- [ ] **Facebook Page post:** one organic post, its receipt and post id recorded; a forced timeout shows "uncertain" and does not post twice.
- [ ] **Voiceover cost:** one voiceover whose billed cost is compared with its hold (confirms the per-character rate).
- [ ] **Alert webhook and Google Drive write:** one of each against the real service.
- [ ] **Restore drill on the deployment's database** (`npm run db:restore-drill`), and `GET /api/ready` watched by an uptime monitor.

## Then

1.1.0 is out. The next stable after it (1.1.1 or 1.2.0) waits on the boxes above having evidence next to them, and on CI being green on its
release commit.
