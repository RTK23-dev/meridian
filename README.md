# Meridian

Beta **0.1.0-beta.3**. Evidence-led advertising research, JEV decisions, Hypit video production, and paused Meta publishing for multi-tenant brands.

You add a brand. Meridian ranks what to make from evidence you store, generates image and video variants, checks them, and writes results back into the next decision.

```
market → JEV Research → advertising patterns → opportunity → JEV → brief → studio
  → image / video → QA → review → publish → performance → learning
```

A provider is **not connected** until one of its requests succeeds. This repository does not include ad accounts, and it does not invent ads, metrics, or publish receipts.

Licensed under the [MIT License](LICENSE). Original code.

## Start here

[docs/SETUP.md](docs/SETUP.md) is the full local and production setup. The short path:

```bash
npm install
cp .env.example .env
# set DATABASE_URL, then:
npm run db:migrate
npm run dev
```

In two more terminals:

```bash
npm run worker
npm run scheduler
```

Open the app, create an account, and add a brand. Without `DATABASE_URL`, the process uses an embedded database that does not survive a restart. Video needs a separate Hypit process at `HYPIT_BASE_URL`. Without ad-account credentials, nothing is published to Meta, TikTok, or Google.

## What this beta includes

- Workspaces, roles, invites, brands, Brand Brain, and products.
- Manual market observations, public-page fetch, and semantic clustering with a local MiniLM model.
- Meta Ad Library video-ad collection, verified source media storage, timestamped transcription, confidence-rated structured JEV Research, and observed cross-ad pattern summaries. Research does not assert effectiveness from frequency.
- Opportunity ranking, JEV decisions, briefs, text QA, and human review.
- Shared browser/server validation on market, creative, performance, publishing, and schedule forms, with field-level errors and unsaved-change feedback.
- JEV uses OpenRouter as its only external model gateway. Optional Studio images can use Google AI Studio / Nano Banana. Studio production video uses Hypit after JEV approval.
- A Hypit MP4 is stored only after the separate process returns bytes. Missing vision evidence does not auto-approve.
- Manual performance and learning that changes the next rank and the next brief.
- Provider clients for Meta, TikTok, Google Ads, and the Meta Ad Library. Confirmed provider ids are stored only after a real response.
- Approved, tenant-scoped Hypit MP4s can be uploaded to Meta and used in a paused campaign/ad-set/ad chain. Upload retries reconcile the prior upload; publishing is not activated automatically.
- Tenant-scoped Meta performance jobs verify the selected ad and account before storing observations.
- A separate worker and scheduler, filesystem storage, and an S3-compatible client.
- Invite email when `EMAIL_API_URL` and `EMAIL_API_KEY` are set. Otherwise the invite is stored and nobody is notified.

## What needs a connection

| Need | Environment | Until then |
| --- | --- | --- |
| Meta ads | A successful tenant Meta connection and ad-account selection; `META_ACCESS_TOKEN` / `META_AD_ACCOUNT_ID` can provide host-configured access, and OAuth uses `META_APP_ID`, `META_APP_SECRET`, `TOKEN_ENCRYPTION_KEY` | Without a usable connection/account, live video upload, paused publication, and Meta performance sync remain `NOT_CONNECTED`. Campaign objects remain paused. |
| Meta Ad Library | `META_AD_LIBRARY_TOKEN` | No ads are collected. |
| JEV model gateway | `OPENROUTER_API_KEY` | Model-backed JEV actions report not configured. |
| JEV Research transcription | local WhisperX; `ffmpeg` and `ffprobe` on the worker | Research transcription reports `NOT_CONNECTED`; no hosted API fallback is used. |
| TikTok ads | `TIKTOK_ACCESS_TOKEN`, `TIKTOK_ADVERTISER_ID`, and for OAuth `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | No campaign is created. |
| Google Ads | `GOOGLE_ADS_ACCESS_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, and for OAuth `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` | No customer is listed. |
| Token storage and webhooks | `TOKEN_ENCRYPTION_KEY`, `WEBHOOK_SECRET` | Tokens are not stored. Webhook posts are rejected. |
| Object storage | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Files stay on the filesystem provider. |
| Video | `HYPIT_BASE_URL` on a separate Hypit 0.2.17 process, with `ffmpeg` and `ffprobe` | Studio reports `HYPIT_NOT_CONNECTED`. No clip is stored. |
| Optional images | `GOOGLE_AI_STUDIO_API_KEY` | Images are skipped; JEV and Hypit video continue. |
| External embeddings | `EXTERNAL_SEMANTIC_URL`, `EXTERNAL_SEMANTIC_KEY` | Local MiniLM is used. No vector is invented for the missing API. |
| Invite email | `EMAIL_API_URL`, `EMAIL_API_KEY` | The invitation is stored. Nobody is emailed. |
| Worker and scheduler | `DATABASE_URL` on a long-lived host | The web process does not run their loops. |

The variable list is [.env.example](.env.example). App secrets stay in the host environment. OAuth tokens are written to Postgres only as AES-256-GCM ciphertext when `TOKEN_ENCRYPTION_KEY` is set.

## Checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

GitHub Actions runs the same checks on `main` and on a published release. This application is not an npm package.

## Layout

- `src/lib/meridian/` — tenancy, brand brain, JEV, opportunities, studio, learning, providers
- `src/routes/` — screens
- `migrations/` — schema
- `evals/` — gate and market fixtures
- `docs/` — behavior, setup, and gaps

## Docs

- [Setup](docs/SETUP.md)
- [Product](docs/PRODUCT.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Providers](docs/PROVIDERS.md)
- [JEV](docs/JEV.md)
- [Database](docs/DATABASE.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [Gap analysis](docs/PRODUCT_GAP_ANALYSIS.md)
- [Changelog](CHANGELOG.md)

## Readiness

| Area | Status |
| --- | --- |
| Decision loop, JEV, learning write-back | In this beta. Stored external advertising evidence and validated performance observations can inform later ranks and briefs. |
| Hypit video and Meta publishing | In this beta: approved briefs can produce stored MP4s through a separate Hypit process; configured Meta connections can publish the verified artifact into a paused campaign chain. This repo does not include Hypit source. |
| Local semantic embeddings, worker, scheduler, filesystem storage | In this beta. |
| Optional Nano Banana images | Google AI Studio integration is optional. No image credentials are required for JEV or Hypit. |
| S3, Meta, TikTok, Google Ads, Ad Library | External connection required. Meta video publishing and performance sync remain `NOT_CONNECTED` until the tenant credential and ad account are configured and verified. |
| Invite email | Stored always. Sent only when the email API answers. |
| Live delivery and live metrics | Meta video publishing and provider performance sync are implemented, but require real tenant credentials/accounts and remain paused until separately activated. Test performance is labeled `test:performance` and is not live delivery data. |

Not a live media buyer while those external accounts are absent. See [docs/PRODUCT_GAP_ANALYSIS.md](docs/PRODUCT_GAP_ANALYSIS.md).
