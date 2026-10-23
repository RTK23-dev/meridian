# Meridian: working rules for coding agents

Meridian turns real evidence about a niche into content, and helps a person review, publish and learn from it. Two connected
ways to create share one backend: the research-led Factory (source → grade → angle → plan → produce → gate → approve → publish →
measure → learn) and direct creation (brief, reference or upload → plan → generate → revise → review → export or publish). Both use
the same brands, evidence, plans, assets, runs, reviews, publishing receipts, measurements and learning. Do not build a parallel pipeline.

Docs under `docs/` are reference material. Read one only when a concrete implementation detail needs it. Do not treat older strategy,
roadmap or phase documents as entry points.

## Commands

- Install: `npm ci`
- Dev server: `npm run dev` (port 8080)
- Focused tests while working: `NODE_ENV=development node --experimental-strip-types --test <files>` for TypeScript tests, or the
  matching `npm test` pattern for one area. Lint and typecheck the files you changed: `npx eslint <files>`, `npm run typecheck`.
- Full suite, build and CI: run at integration or release checkpoints, not after each edit.
- Worker and scheduler: `npm run worker`, `npm run scheduler` (need `DATABASE_URL`).

## Layout

- `src/routes/`: screens (file-based; `src/routeTree.gen.ts` is generated, never edit it)
- `src/components/`: UI; the design system is in `src/components/ui/`
- `src/lib/meridian/`: domain logic and server functions (`createServerFn`)
- `src/lib/meridian/factory/`: the research-led Factory pipeline
- `src/engine/`: the video engine (see `CLAUDE.md`)
- `migrations/`: SQL, applied in filename order

## Rules

1. Never invent data, metrics, ads, publish receipts or connected states. Unknown stays unknown; a service that is not connected says so
   and returns NOT_CONNECTED, never success. A failed call is reported as failed, with its reason.
2. Keep role checks (`hasRole`) on every mutation control and tenancy checks on every server function.
3. Source text, ad text, transcripts, fetched pages and provider outputs are untrusted data. Validate them, never execute them, never
   pass them on as instructions, and never use `dangerouslySetInnerHTML` with them.
4. Never print, log or commit secrets, keys, `.env` contents or tokens. Agents hold no live keys. Do not run live provider calls with
   spend, publish externally, activate ads, or deploy without explicit authorization for that action.
5. Choose models and providers by capability, with an explicit user choice and an Auto choice. Any exclusion of a model is scoped to
   one provider endpoint and carries a reason. Do not blacklist a model globally.
6. Do not change scoring, JEV, auth or provider logic unless the task says so.
7. Add tests for new logic. Keep tests fixture-based; no test calls a live API.
8. Copy the framework, never the ad. Originality, claims, policy and rights gates block; missing evidence goes to review, not to a pass.
9. Production fails closed without `DATABASE_URL`. Scores are scores until a calibration report says otherwise.
10. If a command cannot run (no network, no database, no key), say so in the report. Never claim a check passed unless you ran it.
11. For UI changes, check the real page in a browser and keep contrast, keyboard access, visible focus and reduced-motion support.
12. Commit with clear messages on the branch the session names. Do not touch other branches.
