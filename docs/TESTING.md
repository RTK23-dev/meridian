# Testing

Unit tests cover the decision math without a database:

- `src/lib/meridian/scoring.test.ts` — weights and penalties
- `src/lib/meridian/access.test.ts` — roles
- `src/lib/meridian/brain.test.ts` — completeness
- `src/lib/meridian/loop.test.ts` — learning changes the next rank and the next brief; empty market does not invent a signal; foreign brand ids throw; thin samples emit nothing; guardian evidence maps to approve, review, and reject; missing vision evidence cannot auto-approve
- `src/lib/meridian/jev/fixtures.test.ts` — reads `evals/jev/cases.json`
- `src/lib/meridian/knowledge/model.test.ts` — attribute query and near-duplicate filter
- `src/lib/meridian/workflow/templates.test.ts` — same stages, different variables
- `src/lib/meridian/sources/public-url.test.ts` — private hosts blocked before fetch

Run `npm test`.

`evals/jev/` is the fixture set for the gate. Add a case there when a new question gets a required outcome. The loop test is the self-improvement fixture: it fails if patterns stop affecting rank or if the brief stops retrieving them.

What is not covered: a live model call, a live page fetch, and two signed-in browsers hitting the database. Tenant isolation for those paths is the membership check in `machine.ts` plus `assertSameTenant` before ranking and learning.
