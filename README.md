# Meridian

Beta **0.1.0**. Multi-tenant advertising operating system.

You add a brand. Meridian ranks what to make from evidence you store, generates image and video variants, checks them, and writes results back into the next decision.

```
market → brand brain → opportunity → JEV → brief → studio
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

Open the app, create an account, and add a brand. Without `DATABASE_URL`, the process uses an embedded database that does not survive a restart. Without `XAI_API_KEY`, image and video generation stay unavailable. Without ad-account credentials, nothing is published.

## What this beta includes

- Workspaces, roles, invites, brands, Brand Brain, and products.
- Manual market observations, public-page fetch, and semantic clustering with a local MiniLM model.
- Opportunity ranking, JEV decisions, briefs, text QA, and human review.
- Studio image and video jobs. `xai:video` runs when `XAI_API_KEY` is set. `test:video` is off unless a test enables it.
- Video bytes are stored, frames are sampled from the file, and JEV does not auto-approve missing vision evidence.
- Manual performance and learning that changes the next rank and the next brief.
- Provider clients for Meta, TikTok, Google Ads, and the Meta Ad Library. They store an id only after the response contains one.
- A separate worker and scheduler, filesystem storage, and an S3-compatible client.
- Invite email when `EMAIL_API_URL` and `EMAIL_API_KEY` are set. Otherwise the invite is stored and nobody is notified.

## What needs a connection

| Need | Environment | Until then |
| --- | --- | --- |
| Meta ads | `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, and for OAuth `META_APP_ID`, `META_APP_SECRET` | Not configured. Nothing is published. |
| Meta Ad Library | `META_AD_LIBRARY_TOKEN` | No ads are collected. |
| TikTok ads | `TIKTOK_ACCESS_TOKEN`, `TIKTOK_ADVERTISER_ID`, and for OAuth `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | No campaign is created. |
| Google Ads | `GOOGLE_ADS_ACCESS_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, and for OAuth `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` | No customer is listed. |
| Token storage and webhooks | `TOKEN_ENCRYPTION_KEY`, `WEBHOOK_SECRET` | Tokens are not stored. Webhook posts are rejected. |
| Object storage | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Files stay on the filesystem provider. |
| Image and video models | `XAI_API_KEY` | Generation says the model is unavailable. No clip is stored. |
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
| Decision loop, JEV, learning write-back | In this beta. Tests prove a stored result changes the next rank and brief. |
| Local semantic embeddings, worker, scheduler, filesystem storage | In this beta. A second machine is still a deployment choice. |
| xAI image and video | Adapter is in the product. A clip or image is stored only after the request returns bytes. |
| S3, Meta, TikTok, Google Ads, Ad Library | External connection required. |
| Invite email | Stored always. Sent only when the email API answers. |
| Live ads and live metrics | Not running from this repository. Do not read a client as a connected account. |

Not a live media buyer while those external accounts are absent. See [docs/PRODUCT_GAP_ANALYSIS.md](docs/PRODUCT_GAP_ANALYSIS.md).
