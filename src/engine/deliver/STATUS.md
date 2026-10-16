# STATUS: delivery (W13, phase E5)

Branch `eng-e5-variants`. Covers `src/engine/deliver/` and the deliver handler `src/engine/jobs/handlers/deliver.ts`. The
variants-stage notes and the blockers are in `src/engine/variants/STATUS.md`. Nothing is pushed.

## Built

- Video selection, ledger settlement (reconcile, then release), cost buckets and attribution, the Claude call mapping, the manifest
  writer and write-once artifacts, each with tests.
- The deliver stage: one manifest per delivered video (stable ids), the ledger settled and released under the reservation's lock,
  and the learning events. Each event has a dedupe key.

## Decisions to confirm (lead)

1. **Paid partnership.** No field in the request carries it. The port answers it when the owner sets a rule; with no answer the
   manifest says `true`. Bible 20.2 (disclosure wording and placement) is open. Only the flag is carried; no wording is written.
2. **`aiGeneratedPeople`** is set when a generated shot is a presenter, a cinematic shot (which may show a person, so it is
   treated as one), or an avatar or lip-sync model. A lead decision: is a cinematic shot an AI person?
3. **Invalid answers billed at a known cost.** The manifest refuses such a call (`calls.ts` throws `internal`), because the contract
   holds an invalid answer as the estimate. The request pauses. See `variants/STATUS.md`, blocker 5.
4. **Manifest v2 has no `configVersion`.** The configuration versions go on the `video.delivered` event.
5. **`engine_manifests` is not written.** The manifests are artifacts. The table is not filled.

## Tests

- `ledger.test.ts` (4), `cost.test.ts` (7), `manifest.test.ts` (16), `videos.test.ts` (7), `calls.test.ts` (5), `boundaries.test.ts` (6).
- `src/engine/jobs/handlers/deliver.test.ts` (7, PGlite): both manifests written with the expected shots, costs and gates; the ledger
  settled and released (0.5906 committed, 0.3689 released); a retry writes and emits nothing new; a variant whose review failed is not
  delivered and its render cost stays on the master's record; a given paid-partnership answer is carried; a master that does not
  deliver is refused; no reservation is refused.

## Owner must run live

Against a real PostgreSQL server (MERIDIAN_PG_TEST_URL), run `src/engine/jobs/handlers/deliver.test.ts` and record the manifest rows in
`engine_artifacts`, the reservation row, and the `engine_events` rows. The second run must add none.
