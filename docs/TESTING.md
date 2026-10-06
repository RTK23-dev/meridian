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

Run `npm test`.

`evals/jev/` is the fixture set for the gate. `evals/acceptance/market.json` is the collected-creative fixture for the market-to-learning path. The acceptance test fails if a learned pattern stops changing the next opportunity or the next brief.

What is not covered: a live model call, a live page fetch, a signed-in browser walk of the database, ad-library collection, and publishing. Tenant isolation for server functions is the membership check in `machine.ts`, plus `assertSameTenant` before ranking and learning. The job runner's retry and dead-letter behavior is tested in process. The database queue is drained only when someone recomputes learning. There is no separate worker process in this deployment.
