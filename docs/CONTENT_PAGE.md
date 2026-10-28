# The Content page

Dated 2026-10-24. This is the reference for the one content page: what it is, how it is wired, what was checked, and what comes next.

## Status (2026-10-26)

The single Content page is part of PR #80 on `fix/openrouter-model-routing-jev`. The checkpoint commit hashes and paused-work notes from 2026-10-24 were historical and are not a description of this branch's current head. Use the current PR head and its CI run for release evidence; this document describes the current route/component layout and user-facing behavior.

## Name

The page is called **Content**. It was "Content Factory" until 2026-10-24. The owner-facing section previously called Ads is now Batch, because its main job is to start a research-led production run. The engine's pipeline keeps the name Content Factory in its own docs and code (`src/lib/meridian/content-factory`). The route stays at `/content-factory`, so existing links keep working.

## What the page is

One page per brand where a person makes, reviews, publishes and reads results for the brand's videos and images. The sections are tabs. Each section is the screen that already existed, moved into `src/components/content-factory/sections/`, with its own role checks.

## Where it lives

- `/brands/:brandId/content`: one brand's page (`src/routes/_app/brands/$brandId/content.tsx`).
- `/content-factory`: the same page without a brand in the URL. It shows a brand picker when the workspace has more than one brand (`src/routes/_app/content-factory.tsx`).
- The seven old brand paths redirect to their section, so existing links keep working:

| Old path | Opens |
| --- | --- |
| `/brands/:id/studio` | Create, in the Studio preset |
| `/brands/:id/opportunities` | Ideas |
| `/brands/:id/reviews` | Review |
| `/brands/:id/library` | Library |
| `/brands/:id/accounts` | Publish |
| `/brands/:id/learning` | Results |
| `/brands/:id/factory` | Batch |

The connect-account flow returns to `/brands/:id/accounts`, the only brand path the OAuth return allows, so it lands on Publish.

## Sections

| Section | What it shows | Who sees it |
| --- | --- | --- |
| Create | Starting-mode cards, then the engine or Studio | Everyone. Engine presets are admin-only. |
| Ideas | Ranked opportunities | Everyone |
| Review | Holds waiting for a person | Everyone |
| Library | Stored creatives | Everyone |
| Publish | Connected accounts | Everyone. The screen checks its own roles. |
| Results | Learning: patterns, performance, schedule, sharing | Everyone |
| Batch | The research-led production run builder and its status | Admins only |

A section a person may not use falls back to Create.

## Create presets

| Preset | Mode | Who | Default for |
| --- | --- | --- | --- |
| Video from a brief (`brief`) | engine | admins | admins |
| Video from a reference (`reference`) | engine | admins | |
| Images and videos in Studio (`studio`) | Studio | everyone | members |

## URL state

`?section=`, `?preset=` and `?session=` hold the state. Other values are dropped (`contentSearchOf`). Section tabs add a history entry. A preset choice replaces the current entry. Moving between sections keeps the preset and drops the engine session.

## Navigation

- Brand sidebar: Brand (Overview, Brand brain, Products), Research (Market, Intelligence), Create (Content, with the open review count), Results (Calibration), Settings. The group is named Create so the item is not repeated as "Content / Content".
- Bottom bar on a brand: Overview, Content, Market, Calibration.
- Next step: Intelligence, then Content, then Calibration, then Content.

## Code map

- `content-hub.tsx`: the page. Tabs, presets, brand picker and URL changes.
- `content-hub-model.ts`: the pure rules (sections, presets, search values, old routes). Tests: `content-hub-model.test.ts`.
- `sections/`: the seven screens. Each exports one component and loads when its section opens.
- `screen.tsx`: the engine screen. `embedded` hides its page header inside the page.
- `src/lib/navigation/model.ts`: sidebar, bottom bar, next step and the area guide. Tests: `model.test.ts`.

## Checks

- **Last fully verified code head CI:** [run 40263991449](https://github.com/RTK23-dev/meridian/actions/runs/40263991449), head `b4b94ea984caf9ab3b524fd2999a9f8fbb49678b`, passed all 13 required jobs, including six test shards, PostgreSQL, sidecar, typecheck/lint/build, release acceptance, UI smoke/baseline, E2E and aggregate `check`. The final-head browser evidence is recorded in `docs/RELEASE_ACCEPTANCE.md`.
- The release-acceptance browser flow uses a fresh embedded database, a fixture-only sealed dummy token, and local browser requests. It checks stale provider readiness without probing a provider; the 25-hour-old Meta card reads DEGRADED, never HEALTHY or live-verified.
- The Content page browser checks passed for accessible workflow tabs, selected preset state, the no-brand empty state and phone-width overflow. Desktop and 390 px screenshots are attached to the same CI run.
- Live provider behavior, real credentials, paid calls, publishing and external side effects are intentionally not exercised.

## Remaining work and boundaries

- **Browser verification is complete on the recorded head** `b4b94ea984caf9ab3b524fd2999a9f8fbb49678b` in [CI run 40263991449](https://github.com/RTK23-dev/meridian/actions/runs/40263991449): the desktop/phone workflow checks, role-gated Batch tab, selected preset and local-only acceptance passed. A later code change must be rechecked on its own head.
- Keep the old section URLs as redirects and preserve URL-backed tab/preset/session state; these are compatibility behavior, not cleanup candidates.
- The Content page's Batch section remains admin-only. Its default subtab is Make a batch, with the run builder visible; Factory Line and other technical panels remain available as advanced tabs. Each underlying section keeps its server-side role checks.
- Repurpose upload proof is fixture-only and uses an injected fake transport. The paused-ad proof creates and reads back an ad as `PAUSED`; it never activates or publishes it.
- Live providers, credentials, paid requests and external publishing remain outside automated browser verification.
- Backend unification is not started: one run record, one ledger, one approval path, one provider router, one planner, one publish door.
- Calibration is still its own page.
- Line of record (which branch is the release line): owner decision.
