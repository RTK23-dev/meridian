# Meridian

Multi-tenant advertising operating system. Understand a brand you add yourself, rank what to make from evidence you store, and write results back into the next decision.

Workspaces, brands, the Brand Brain, products, manual market observations, opportunity scoring, JEV gates, briefs, text QA, review, manual performance, and learning are connected. Ad-library scraping, vision QA, and ad-account performance are not. See [docs/PRODUCT.md](docs/PRODUCT.md) and [docs/PRODUCT_GAP_ANALYSIS.md](docs/PRODUCT_GAP_ANALYSIS.md).

Licensed under the [MIT License](LICENSE). Original code. Not a republication of Hypit or any other advertising tool.

## Stack

TanStack Start, React, Postgres, Better Auth.

Auth and the database are provided by the host in deployment (`DATABASE_URL` and the auth broker). They are not stored in the repository. Text generation uses `XAI_API_KEY` or `OPENROUTER_API_KEY` when one of those is present, and says so when it is not.

## Local checks

```bash
npm install
npm test
npm run typecheck
npm run build
```

`npm run dev` serves the app. Migrations in `migrations/` apply on startup.

## Layout

- `src/lib/meridian/` — tenancy, brand brain, JEV, opportunities, learning, providers
- `src/routes/` — screens
- `migrations/` — auth, tenant, and machine schema
- `evals/jev/` — gate fixtures
- `docs/` — what exists, not a wish list
