# STATUS: learning events (W13, phase E5)

Branch `eng-e5-variants`. Covers `src/engine/events/`. Nothing is pushed.

## Built

- The event kinds and schemas (`schema.ts`), the in-memory store (`store.ts`), and validated emission with dedupe keys (`emit.ts`).
- Tests: `emit.test.ts` (13): the kinds, the schemas, a dropped check detail, the dedupe, the refusal of an invalid event before any write,
  and the batch count.

## Used by

- `jobs/handlers/variants.ts`: `variant.planned` for each planned, deferred, not-built and skipped variant.
- `jobs/handlers/deliver.ts`: `cost.reconciled`, `gate.result`, `video.delivered`, `variant.delivered`, `request.delivered`.

## Lead decisions

1. The `gate.result` events are written at delivery from the stored gate rows. Writing them from the orchestrator's effect writer
   (when each gate is produced) would be real-time (Bible 16.1). The dedupe keys make either choice safe to repeat.
2. The Postgres `EventStore` is not written here. The row shape matches the `engine_events` table in migration 0077, and the
   orchestrator's own `recordEvent` (`jobs/orchestrator-sql.ts`) uses the same insert.
3. `plan.decided`, `take.checked`, `shot.downgraded` and `review.decided` have schemas but no emitter yet. Their stages emit them when
   they run (E3 to E4).
