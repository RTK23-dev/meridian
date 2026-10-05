# Meridian

Multi-tenant advertising operating system. Understand a brand you add yourself, keep that record, and refuse to invent the rest.

This version covers workspaces, brands, the Brand Brain, products, roles, and an audit log. Market collection, generation, QA, and performance learning are not connected. See [docs/PRODUCT.md](docs/PRODUCT.md).

Licensed under the [MIT License](LICENSE). Original code. Not a republication of Hypit or any other advertising tool.

## Stack

TanStack Start, React, Postgres, Better Auth.

Auth and the database are provided by the host in deployment (`DATABASE_URL` and the auth broker). They are not stored in the repository.

## Local checks

```bash
npm install
npm test
npm run typecheck
npm run build
```

`npm run dev` serves the app. Migrations in `migrations/` apply on startup.

## Layout

- `src/lib/meridian/` — roles, scoring, Brand Brain shape, server functions
- `src/routes/` — screens
- `migrations/0002_meridian.sql` — tenant schema
- `docs/` — what exists, not a wish list
