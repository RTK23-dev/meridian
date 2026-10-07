# Architecture

TanStack Start application. Postgres (Neon when deployed, embedded Postgres in preview) is the system of record. Server functions are the API. The browser never sends a user id the server trusts.

## Loop

```
organization → brand → brand brain / products
        → observations and public-page documents
        → Meta Ad Library collection job
        → verified source MP4 → timestamped transcript → typed JEV Research analysis
        → durable ad evidence and observed corpus patterns
        → external pattern opportunity
        → opportunity ranker
        → JEV opportunity gate
        → brief
        → human script or text provider
        → text guardian → JEV creative QA
        → library, review, or rejection
        → approved stored Hypit MP4 → verified tenant/JEV lineage → confirmed Meta video upload
        → paused Meta campaign / ad set / video creative / ad
        → manual performance or a provider sync that passed the normalizer
        → learning job on the worker
        → learned patterns
        → next rank and next brief
```

The web process does not execute the worker loop. `scripts/worker-entry.ts` claims jobs. `scripts/scheduler-entry.ts` only enqueues. Both need `DATABASE_URL`. Meta video uploads persist a per-organization idempotency reservation and reconcile ambiguous outcomes before retrying; Meta's confirmed video id and artifact lineage are persisted before the paused campaign chain continues. Meta performance jobs revalidate tenant/brand ownership and the tenant credential's access to the selected ad account.

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
| JEV Research | `research/`, `providers/meta-research.ts` | Tenant-scoped Ad Library collection, verified media, transcript, evidence-grounded analysis, and corpus summaries |
| Content Factory | `factory/` | Creative DNA v2, pgvector embeddings, trends clustering, multi-aspect rendering, autopilot levels |
| Flow Connectors | `flow/` | Standardized n8n-style node connectors (`FlowNode`, `FlowPipeline`, `createFlow`) |
| Grading Engine | `grading/engine.ts` | Swappable grading: `WinnerScoreGradingEngine`, `HeuristicGradingEngine` |
| Planner Engine | `planner/engine.ts` | Swappable planning: `MatrixPlannerEngine` (permutational variant matrices) |
| Video Engine | `video/engine.ts` | Swappable rendering: `HypitVideoEngine`, `TimelineVideoEngine` |
| Publish Engine | `publishing/engine.ts` | Swappable publishing: `MetaPublishEngine`, `TestPublishEngine` |
| Distribution | `distribution/` | Multi-channel selective delivery: Meta, TikTok, Google, IG Reels, FB Pages, YouTube Shorts |
| API | `machine.ts` | Persistence and tenant checks |

AI output is parsed into fields and then checked by deterministic code. Retrieved page text is wrapped as `untrusted_source` and is not allowed to act as instructions.

Creative production uses original workflow stages. It does not embed another product's runtime.

JEV Research analyzes external advertising evidence; it is not an approval gate. It uses OpenRouter for structured analysis and local WhisperX for transcript extraction. Missing media, transcription, or model configuration is recorded explicitly. Research frequency is not an effectiveness claim. Organization summaries are used only for brands with the existing organization-learning opt-in and contain aggregate counts without examples or source ids.

## Request path

1. Session middleware resolves `userId`.
2. The brand id is resolved to an organization. Membership is required.
3. Mutations write the row, a JEV decision when a gate runs, and an audit row.
