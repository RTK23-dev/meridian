# Learning events (W13, Video Engine Bible section 16)

Implements Video Engine Bible **section 16.1**: the events the engine writes to `engine_events` (append-only), at the moment they
happen. Each event has a kind, the stage and subject it is about, a dedupe key and a body that is validated before it is stored.

## Files

| File | What it does |
| --- | --- |
| `schema.ts` | The kinds and their body schemas: the seven of Bible 16.1, and three the engine adds (`request.delivered`, `variant.delivered`, `variant.planned`). A check's free-text detail is never stored. |
| `store.ts` | The `EventStore` interface (append with a dedupe key, list one request's events) and an in-memory store. The Postgres store is the lead's or eng-pipeline's: an insert with `on conflict (organization_id, dedupe_key) do nothing`. |
| `emit.ts` | `emitLearningEvent` and `emitLearningEvents`. Each event is validated first; a refusal stores nothing. A dedupe key that is already stored changes nothing. |

## Tests

`NODE_ENV=development node --experimental-strip-types --test 'src/engine/events/*.test.ts'`. See `STATUS.md`.
