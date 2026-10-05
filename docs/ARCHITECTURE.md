# Architecture

The running app is a TanStack Start application. Postgres (Neon when deployed, embedded Postgres in local preview) is the system of record. Server functions are the API. The browser never sends a user id that the server trusts.

## Modules that exist

| Module | Status |
| --- | --- |
| Auth and session | Wired. Google and X. |
| Organizations and memberships | Implemented. |
| Brands, Brand Brain, products | Implemented. |
| Audit log | Implemented. |
| Opportunity scoring | Pure function plus stored weights. No candidates yet. |
| Ingestion, market data, generation, QA, performance, learning | Not built. Interfaces are not faked. |

## Request path

1. The session middleware resolves `userId`.
2. The handler loads the brand or workspace and checks membership.
3. Mutations write the row, a version when the brain changes, and an audit row.

AI providers are not called. When they are added, they must sit behind a server-only adapter. Keys stay on the server. External page text must be passed as untrusted data, never as instructions.

Creative production, when built, should use an original stage model (hook, proof, offer, call to action, and so on) owned by the brand. It should not embed another product’s runtime.
