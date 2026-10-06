# Architecture

TanStack Start application. Postgres (Neon when deployed, embedded Postgres in preview) is the system of record. Server functions are the API. The browser never sends a user id the server trusts.

## Loop

```
organization → brand → brand brain / products
        → observations and public-page documents
        → opportunity ranker
        → JEV opportunity gate
        → brief
        → human script or text provider
        → text guardian → JEV creative QA
        → library, review, or rejection
        → manual performance or a provider sync that passed the normalizer
        → learning job on the worker
        → learned patterns
        → next rank and next brief
```

The web process does not execute the worker loop. `scripts/worker-entry.ts` claims jobs. `scripts/scheduler-entry.ts` only enqueues. Both need `DATABASE_URL`.

## Modules

| Module | Where | Role |
| --- | --- | --- |
| Tenancy | `src/lib/meridian/access.ts`, `api.ts` | Roles and membership |
| Brand brain | `brain.ts`, `api.ts` | Structured brand record |
| Knowledge | `knowledge/` | Attribute query, graph edges, retrieval scope |
| Opportunity | `opportunity/` | Hypothesis catalog, ranker, refresh |
| JEV | `jev/` | Threshold gate |
| Guardian | `guardian/text.ts`, `vision/logo.ts` | Text evidence and PNG logo search |
| Brief and workflow | `brief/`, `workflow/` | Context pack and templates |
| Learning | `learning/` | CTR, CVR, ROAS, pairs, positive and negative lift |
| Jobs | `jobs/sql-worker.ts`, `scripts/worker-entry.ts` | Lease, retry, dead letter. Not inside the page render |
| Scheduler | `scripts/scheduler-entry.ts` | Inserts due schedules and heartbeats |
| Semantic | `embeddings/semantic.ts`, `semantic/lexical.ts` | Local MiniLM, plus a labeled lexical hash |
| Assets | `storage/`, `assets/` | Filesystem and S3-compatible clients. Database blobs are a migration source |
| Experiments | `experiments/` | Allocation and sample floor. Not sent to an ad account by themselves |
| Providers | `providers/meta.ts`, `tiktok.ts`, `google-ads.ts`, `connect.ts` | Live HTTP. Test provider is explicit |
| Sources | `sources/` | Manual adapter, public-page fetch, SSRF checks |
| API | `machine.ts` | Persistence and tenant checks |

AI output is parsed into fields and then checked by deterministic code. Retrieved page text is wrapped as `untrusted_source` and is not allowed to act as instructions.

Creative production uses original workflow stages. It does not embed another product's runtime.

## Request path

1. Session middleware resolves `userId`.
2. The brand id is resolved to an organization. Membership is required.
3. Mutations write the row, a JEV decision when a gate runs, and an audit row.
