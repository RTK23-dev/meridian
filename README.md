# Meridian

Multi-tenant advertising operating system. You add a brand, Meridian ranks what to make from evidence you store, and results write back into the next decision.

The application code for the loop is in this repository: Brand Brain, opportunities, JEV, briefs, review, learning, a separate worker, a scheduler, local semantic embeddings, and provider clients for Meta, TikTok, Google Ads, and the Meta Ad Library. A provider is **not connected** until one of its requests succeeds. This repository does not include ad accounts, and it does not invent ads, metrics, or publish receipts.

See [docs/PRODUCT.md](docs/PRODUCT.md), [docs/PRODUCT_GAP_ANALYSIS.md](docs/PRODUCT_GAP_ANALYSIS.md), [docs/PROVIDERS.md](docs/PROVIDERS.md), and [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md).

Licensed under the [MIT License](LICENSE). Original code. Not a republication of Hypit or any other advertising tool.

## What you can run without an ad account

- Workspaces, roles, brands, Brand Brain, and products.
- Manual market observations and one public-page fetch.
- Opportunity ranking, briefs, text QA, and review.
- Manual performance and learning that changes the next rank.
- An explicit `test:` provider for deterministic integration tests. It is off unless the test enables it.

## What needs a customer connection

| Need | Environment | Until then |
| --- | --- | --- |
| Meta ads | `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID` | Not configured. Nothing is published. |
| Meta Ad Library | `META_AD_LIBRARY_TOKEN` | No ads are collected. |
| TikTok ads | `TIKTOK_ACCESS_TOKEN`, `TIKTOK_ADVERTISER_ID` | No campaign is created. |
| Google Ads | `GOOGLE_ADS_ACCESS_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | No customer is listed. |
| Object storage | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Files stay on the filesystem provider. |
| Text or image models | `XAI_API_KEY` or `OPENROUTER_API_KEY` | Generation says the model is unavailable. |
| Worker and scheduler | `DATABASE_URL` on a long-lived host | The web process does not run their loops. |

Credentials stay in the host environment. They are not written into Postgres.

## Stack

TanStack Start, React, Postgres, Better Auth.

Auth and the database are provided by the host in deployment (`DATABASE_URL` and the auth broker). They are not stored in the repository.

## Local checks

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

`npm run dev` serves the app. Migrations in `migrations/` apply on startup. `scripts/worker-entry.ts` and `scripts/scheduler-entry.ts` are separate processes and require `DATABASE_URL`.

## Layout

- `src/lib/meridian/` — tenancy, brand brain, JEV, opportunities, learning, providers
- `src/routes/` — screens
- `migrations/` — schema, including provider connection records
- `evals/` — gate and market fixtures
- `docs/` — what the code does, including gaps

## Readiness

| Area | Status |
| --- | --- |
| Decision loop, JEV, learning write-back | COMPLETE in code. Tests prove a stored result changes the next rank and brief |
| Local semantic embeddings, worker, scheduler, filesystem storage | COMPLETE in this runtime. A second machine is DEPLOYMENT REQUIRED |
| S3, Meta, TikTok, Google Ads, Ad Library | EXTERNAL CONNECTION REQUIRED. Clients store an id only after the response contains one |
| Meta performance sync job | COMPLETE as a worker job. TikTok and Google performance clients are not implemented, so they are not scheduled |
| OAuth callback and sealed token storage | COMPLETE in code. App ids and `TOKEN_ENCRYPTION_KEY` are EXTERNAL CONNECTION REQUIRED |
| Signed webhooks | COMPLETE as verification and dedupe. A provider subscription is EXTERNAL CONNECTION REQUIRED |
| Calibration approval | COMPLETE on the learning page. Nothing changes until an admin approves |
| Alert delivery | COMPLETE in the product. An external page is not sent unless a webhook target accepts it |
| Authenticated axe and screen-reader pass | MANUAL VERIFICATION REQUIRED |
| Live ads and live metrics | Not running here. Do not read a client as a connected account |

Not production-ready as a live media buyer while those external and manual items are open. The gap table is [docs/PRODUCT_GAP_ANALYSIS.md](docs/PRODUCT_GAP_ANALYSIS.md).

