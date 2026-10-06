# Testing

Unit tests cover the decision math without a database:

- `src/lib/meridian/scoring.test.ts` — weights and penalties
- `src/lib/meridian/access.test.ts` — roles
- `src/lib/meridian/brain.test.ts` — completeness
- `src/lib/meridian/loop.test.ts` — learning changes the next rank and the next brief; empty market does not invent a signal; foreign brand ids throw; thin samples emit nothing; guardian evidence maps to approve, review, and reject; missing vision evidence cannot auto-approve
- `src/lib/meridian/acceptance.test.ts` — reads `evals/acceptance/market.json`, discovers an opportunity from those rows, refuses a copied hook line, routes missing vision to human review, retries a learning job, proves a learned pair changes the next brief, and checks that calibration does not move thresholds
- `src/lib/meridian/jev/fixtures.test.ts` — reads `evals/jev/cases.json`
- `src/lib/meridian/knowledge/model.test.ts` — attribute query and near-duplicate filter
- `src/lib/meridian/workflow/templates.test.ts` — same stages, different variables
- `src/lib/meridian/sources/public-url.test.ts` — private hosts blocked before fetch

- `src/lib/meridian/blockers.test.ts` — semantic retrieval, negative learning, worker lease, storage, PDF extraction, logo pixels, calibration
- `src/lib/meridian/providers/readiness.test.ts` — provider probes store only returned ids, campaign retry does not create a second campaign, test provider stays off, contrast ratios

Run `npm test`.

`evals/jev/` is the fixture set for the gate. `evals/acceptance/market.json` is the collected-creative fixture for the market-to-learning path. The acceptance test fails if a learned pattern stops changing the next opportunity or the next brief.

What is not covered: a live model call, a live page fetch against the public internet, a signed-in browser walk, and a real ad account. Provider tests use a scripted HTTP transport. The `test:` provider throws unless the test turns it on. The worker is covered in process by `blockers.test.ts`. It is not started by the unit test against a second machine.
