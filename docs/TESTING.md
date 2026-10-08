# Testing

Unit tests cover the decision math without a database:

- `src/lib/meridian/scoring.test.ts` — weights and penalties
- `src/lib/meridian/access.test.ts` — roles
- `src/lib/meridian/brain.test.ts` — completeness
- `src/lib/meridian/loop.test.ts` — learning changes the next rank and the next brief; empty market does not invent a signal; foreign brand ids throw; thin samples emit nothing; guardian evidence maps to approve, review, and reject; missing vision evidence cannot auto-approve
- `src/lib/meridian/acceptance.test.ts` — includes the external advertising research-to-Hypit acceptance path: bounded Meta collection, transcript extraction, typed analysis, corpus pattern, opportunity, JEV, brief, and Hypit lineage; it also checks evidence confidence, source dedupe, and no causal performance claims
- `src/lib/meridian/jev/fixtures.test.ts` — reads `evals/jev/cases.json`
- `src/lib/meridian/knowledge/model.test.ts` — attribute query and near-duplicate filter
- `src/lib/meridian/workflow/templates.test.ts` — same stages, different variables
- `src/lib/meridian/sources/public-url.test.ts` — private hosts blocked before fetch

- src/lib/meridian/blockers.test.ts — semantic retrieval, negative learning, worker lease, storage, PDF extraction, logo pixels, calibration
- src/lib/meridian/testing/historical-regression.test.ts — 28-point regression test suite guarding against data fabrication, loose JEV fallbacks, unconfigured provider assumptions, drive resolution failures, and simulated telemetry
- src/lib/meridian/providers/readiness.test.ts — provider probes store only returned ids, campaign retry does not create a second campaign, test provider stays off, contrast ratios
- src/lib/meridian/providers/completion.test.ts — paused publishing stages, insight dedupe, OAuth seal, webhook rejection, calibration approval source
- src/lib/meridian/providers/final.test.ts — TikTok and Google stage reuse, insight clients, performance-to-brief, schedules, refresh, alert dead-letter, calibration tenancy

Run `npm test`.

`node scripts/a11y-audit.mjs` signs up through the real form and runs axe on the signed-in screens, plus a keyboard walk, a narrow viewport, and reduced motion. It needs the app already running. It does not bypass authentication. It is not a screen-reader pass and it does not claim WCAG conformance.

`evals/jev/` is the fixture set for the gate. `evals/acceptance/market.json` is the collected-creative fixture for the market-to-learning path. The acceptance test fails if a learned pattern stops changing the next opportunity or the next brief.

What is not covered: a live model call, a live page fetch against the public internet, VoiceOver/NVDA/JAWS, and a real ad account. Provider tests use a scripted HTTP transport. The `test:` provider throws unless the test turns it on. The worker is covered in process by `blockers.test.ts`. It is not started by the unit test against a second machine.
