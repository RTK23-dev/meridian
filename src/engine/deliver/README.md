# Delivery: manifests, the ledger at delivery, and the delivered videos (W13)

Implements Video Engine Bible **section 6.14** (deliver), the settle step of **14.1** (reconcile, then release) and the manifest of
**section 4.4** (Manifest v2, with `roleCalls`). The handler that runs it is `src/engine/jobs/handlers/deliver.ts`.

## Files

| File | What it does |
| --- | --- |
| `videos.ts` | **Pure.** `selectVideos` chooses the delivered video of each edit: the newest render of the edit that has a passing post-render review. The master must deliver. A variant that did not deliver is listed with its reason. |
| `ledger.ts` | `settleLedger(ledger, reservationId)`: reconciles each open entry (the bill, else the list price, else the held amount, flagged as an estimate), then releases the reservation to what is committed. Idempotent. Uses `budget/reconcile.ts`. |
| `cost.ts` | **Pure.** The four buckets of `Manifest.cost` (brain, generation, render, other, from `budgets.fixedStages`) and `attributeRows`: each ledger row goes to one video. A render goes to the video whose composition hash is its idempotency key; every other row goes to the master. |
| `calls.ts` | **Pure.** `requestCallsOf` turns the Claude role-call journal into the manifest's `roleCalls`, `promptVersions` and the count of unanswered calls. It refuses two prompt versions of one role, and an invalid answer the contract cannot hold (see STATUS.md). |
| `manifest.ts` | **Pure.** `buildManifest` builds Manifest v2 for one video and parses it against `manifestSchema`. Also `shotsFor` (the shots its EDL plays, from their takes), `disclosuresFor` (the flags), `timingsFor` and `gatesFor` (a video's own gates, and the request's). |
| `write-once.ts` | `writeArtifactOnce`: an artifact under a stable id is reused on a retry when its body is the same, and refused when it differs (Bible 5.2: artifacts are immutable). |

## Rules

- The manifests of the delivered videos together hold every paid call once. A test checks that the sum of their totals equals the
  ledger's committed total.
- A variant's manifest names the master as `variantOf` and lists its own shots and cost. It lists no role calls, since its calls are
  the master's. Its decisions are the plan's.
- Unknown values stay left out or are refused, never guessed: a shot with no take is not listed, and a clip that plays media no take
  made refuses the manifest.
- The paid-partnership flag is taken from a port. When no answer is given it is `true` (unknown is disclosed). See STATUS.md.

## Tests

`NODE_ENV=development node --experimental-strip-types --test 'src/engine/deliver/*.test.ts'`. The handler test on PostgreSQL (PGlite)
is `src/engine/jobs/handlers/deliver.test.ts`.
