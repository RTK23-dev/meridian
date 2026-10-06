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
| Meta ads | `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, and for OAuth `META_APP_ID`, `META_APP_SECRET` | Not configured. Nothing is published. |
| Meta Ad Library | `META_AD_LIBRARY_TOKEN` | No ads are collected. |
| TikTok ads | `TIKTOK_ACCESS_TOKEN`, `TIKTOK_ADVERTISER_ID`, and for OAuth `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | No campaign is created. An ad also needs an uploaded image or video id. |
| Google Ads | `GOOGLE_ADS_ACCESS_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, and for OAuth `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` | No customer is listed. |
| Token storage and webhooks | `TOKEN_ENCRYPTION_KEY`, `WEBHOOK_SECRET` | Tokens are not stored. Webhook posts are rejected. |
| Object storage | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Files stay on the filesystem provider. |
| Text or image models | `XAI_API_KEY` or `OPENROUTER_API_KEY` | Generation says the model is unavailable. |
| Worker and scheduler | `DATABASE_URL` on a long-lived host | The web process does not run their loops. |

App secrets stay in the host environment. OAuth access and refresh tokens are written to Postgres only as AES-256-GCM ciphertext when `TOKEN_ENCRYPTION_KEY` is set. The UI does not return them.

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
| Meta, TikTok, and Google performance sync | EXTERNAL CONNECTION REQUIRED. The worker fetches insights, rejects missing counts, dedupes, and enqueues learning only after a new row. A schedule is stored only after a healthy connection |
| OAuth callback, refresh, and sealed token storage | EXTERNAL CONNECTION REQUIRED. The server exchanges the code and can rotate a stored refresh token. App ids and `TOKEN_ENCRYPTION_KEY` are still required |
| Signed webhooks | EXTERNAL CONNECTION REQUIRED for the provider subscription. Signature, replay, duplicate, and unknown-account checks are implemented |
| Calibration approval | COMPLETE in code. An admin proposes from stored reviewer outcomes and approves on the learning page. Nothing changes before that |
| Alert delivery | EXTERNAL CONNECTION REQUIRED for paging. In-app alerts can be recorded, acknowledged, and queued to a webhook. Delivery is not claimed without a target response |
| Authenticated axe and keyboard walk | The script is `node scripts/a11y-audit.mjs` against a running app. It uses the real sign-up form. A screen-reader pass is still MANUAL VERIFICATION REQUIRED |
| Live ads and live metrics | Not running here. Do not read a client as a connected account |

Not production-ready as a live media buyer while those external and manual items are open. The gap table is [docs/PRODUCT_GAP_ANALYSIS.md](docs/PRODUCT_GAP_ANALYSIS.md).

