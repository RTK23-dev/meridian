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
        → manual performance
        → learning job (queued, not a background worker)
        → learned patterns, including attribute pairs
        → next rank and next brief
```

## Modules

| Module | Where | Role |
| --- | --- | --- |
| Tenancy | `src/lib/meridian/access.ts`, `api.ts` | Roles and membership |
| Brand brain | `brain.ts`, `api.ts` | Structured brand record |
| Knowledge | `knowledge/model.ts` | Attribute query and similarity |
| Opportunity | `opportunity/` | Hypothesis catalog and ranker |
| JEV | `jev/` | Threshold gate |
| Guardian | `guardian/text.ts` | Text evidence only |
| Brief and workflow | `brief/`, `workflow/` | Context pack and templates |
| Learning | `learning/engine.ts` | Single attributes and pairs. States are OBSERVED, INFERRED, VALIDATED |
| Jobs | `jobs/runner.ts`, `jobs` table | Retry, backoff, dead letter, idempotency. Drained by recompute, not a daemon |
| Semantic | `semantic/lexical.ts` | Token-hash similarity. Neural embeddings are not connected |
| Assets | `assets/lifecycle.ts`, `assets` table | Hash of composed text. No object store |
| Experiments | `experiments/design.ts` | Hypothesis, CTR as the success metric, expected learning |
| Providers | `providers/` | xAI and OpenRouter chat, xAI image |
| Sources | `sources/` | Manual adapter, public-page fetch, SSRF checks |
| API | `machine.ts` | Persistence and tenant checks |

AI output is parsed into fields and then checked by deterministic code. Retrieved page text is wrapped as `untrusted_source` and is not allowed to act as instructions.

Creative production uses original workflow stages. It does not embed another product's runtime.

## Request path

1. Session middleware resolves `userId`.
2. The brand id is resolved to an organization. Membership is required.
3. Mutations write the row, a JEV decision when a gate runs, and an audit row.
