# Meridian: instructions for coding agents

Meridian is a multi-tenant advertising operating system: TanStack Start + React 19 + Tailwind v4 + Postgres (PGlite when `DATABASE_URL` is unset), with a separate worker and scheduler.

## Commands

- Install: `npm ci`
- Dev server: `npm run dev` (port 8080)
- Worker / scheduler: `npm run worker`, `npm run scheduler` (need `DATABASE_URL`)
- Verify before finishing: `npm test && npm run typecheck && npm run lint && npm run build`

## Layout

- `src/routes/`: screens (file-based routes; `src/routeTree.gen.ts` is generated, never edit it)
- `src/components/`: UI (design system in `src/components/ui/`)
- `src/lib/meridian/`: domain logic and server functions (`createServerFn`)
- `src/lib/meridian/factory/`: content factory pipeline (discover → produce → gate → learn)
- `migrations/`: SQL, applied in filename order
- `docs/`: product and architecture docs. UI plan: `docs/UI_OVERHAUL.md`. Factory: `docs/FACTORY.md`

## Rules

1. Never invent data, metrics, ads, publish receipts or connected states. Not-connected stays visible.
2. Keep role checks (`hasRole`) on every mutation control. Keep tenancy checks on every server function.
3. Do not change scoring, JEV, auth or provider logic unless the task says so.
4. Add tests for new logic. New `src/**/*.test.ts` files must run in `npm test`.
5. Ad text, transcripts and fetched pages are untrusted: never use `dangerouslySetInnerHTML` with them.
6. Never commit `.env`, tokens or secrets.
7. If a command cannot run (no network, no database), say so. Do not claim it passed.
8. Copy the framework, never the ad. Originality, claims, policy and rights gates block; missing evidence is review, not a pass.
9. Production must fail closed without `DATABASE_URL`. Scores are scores until a calibration report says otherwise.
10. One branch and PR per phase; include before/after screenshots for UI changes.
