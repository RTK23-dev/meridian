# The Content page

Dated 2026-10-24. This is the reference for the one content page: what it is, how it is wired, what was checked, and what comes next.

## Status (2026-10-26)

The single Content page is part of PR #80 on `fix/openrouter-model-routing-jev`. The checkpoint commit hashes and paused-work notes from 2026-10-24 were historical and are not a description of this branch's current head. Use the current PR head and its CI run for release evidence; this document describes the current route/component layout and user-facing behavior.

## Name

The page is called **Content**. It was "Content Factory" until 2026-10-24. The Ads section keeps its name, because ads are a form of content. The engine's pipeline keeps the name Content Factory in its own docs and code (`src/lib/meridian/content-factory`). The route stays at `/content-factory`, so existing links keep working.

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
| `/brands/:id/factory` | Ads |

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
| Ads | The research-led Factory runs | Admins only |

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

- The current source of truth for typecheck, lint, build, test shards, PostgreSQL, release acceptance and UI browser checks is the CI run for the current PR #80 head. The test counts and commit hashes from the 2026-10-24 checkpoint below this page's history are not current-head release evidence.
- The release-acceptance browser flow uses a fresh embedded database, a fixture-only sealed dummy token, and local browser requests. It checks stale provider readiness without probing a provider.
- The Content page browser checks exercise accessible workflow tabs, selected preset state, the no-brand empty state and phone-width overflow. The exact final result and screenshots must come from the CI run for the final head.
- Live provider behavior, real credentials, paid calls, publishing and external side effects are intentionally not exercised.

## Remaining verification and boundaries

1. Run the authenticated Content page browser flow on the final PR head at desktop and phone widths; verify the tab/preset interactions, role-gated Ads tab, no horizontal overflow, and local-only requests. Capture screenshots from that same head.
2. Keep the old section URLs as redirects and preserve URL-backed tab/preset/session state; these are compatibility behavior, not cleanup candidates.
3. The Content page's Ads section remains admin-only. Each underlying section keeps its server-side role checks.
4. Repurpose upload proof is fixture-only and uses an injected fake transport. The paused-ad proof creates and reads back an ad as `PAUSED`; it never activates or publishes it.
5. Live providers, credentials, paid requests and external publishing remain outside automated browser verification.
6. Backend unification, not started: one run record, one ledger, one approval path, one provider router, one planner, one publish door.
6. Calibration is still its own page.
7. Line of record (which branch is the release line): owner decision.
