# Release checklist: from beta to stable

The current version is a pre-release. These gates must all be recorded before the label changes. A gate is recorded by writing the date, the commit, and the evidence (ids, costs, output) under it. A fixture result never counts for a live gate.

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

## Then

Change the version, move the Unreleased notes under it in CHANGELOG.md, and remove "pre-release" from the README only after every box above has evidence next to it.
