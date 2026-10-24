# The Content Factory page

Dated 2026-10-24. This is the reference for the one content page: what it is, how it is wired, what was checked, and what comes next.

## Checkpoint

- Code: `8b9a173d` on `feat/one-content-page`, one commit on top of `origin/main`.
- Base: `97cba9a3` (`origin/main`). It already holds RTK's PR #75 (`c5d6b6bf`) and PR #76 (`97cba9a3`), both merged on 2026-10-24.
- This document is committed on top of the code. The tag `checkpoint/one-content-page-2026-10-24` points at that commit.
- Not in this checkpoint: the Repurpose, paused Meta ad and Hypit bridge work on `code/beautiful-cori-1zfk11` (37 commits).

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

- Brand sidebar: Brand (Overview, Brand brain, Products), Research (Market, Intelligence), Content (Content Factory, with the open review count), Results (Calibration), Settings.
- Bottom bar on a brand: Overview, Content, Market, Calibration.
- Next step: Intelligence, then Content Factory, then Calibration, then Content Factory.

## Code map

- `content-hub.tsx`: the page. Tabs, presets, brand picker and URL changes.
- `content-hub-model.ts`: the pure rules (sections, presets, search values, old routes). Tests: `content-hub-model.test.ts`.
- `sections/`: the seven screens. Each exports one component and loads when its section opens.
- `screen.tsx`: the engine screen. `embedded` hides its page header inside the page.
- `src/lib/navigation/model.ts`: sidebar, bottom bar, next step and the area guide. Tests: `model.test.ts`.

## Checks at this checkpoint

- Typecheck: `npm run typecheck` passes.
- Lint: `npm run lint` has no errors. Its four warnings are the fast-refresh rule, and all four are on the base branch. One of them is in `intelligence-whitespace.tsx`, a file this change edited, on code this change did not touch.
- Tests, run as the two halves of `npm test`:
  - Scripts: 160 pass, 0 fail.
  - Src: 6,251 tests, 6,210 pass, 0 fail, 41 skipped. The skips need `MERIDIAN_PG_TEST_URL` (the PostgreSQL paths) or a live Gemini key, so the PostgreSQL paths did not run.
- Build: `vite build` passes and regenerates `src/routeTree.gen.ts`.
- Not checked: the page in a browser (AGENTS.md rule 11), screenshots, and any live provider run.

## Next, in order

1. Check the page in a browser as an admin and as a member, at desktop and phone width. Capture before and after.
2. Section headings: each embedded section still shows its own eyebrow and page title under the page title. Make them section headings.
3. Move the brand overview's stage links and next-action links (`src/components/brand-overview/pipeline.ts`), and the home attention links, to the section links. They work now through the redirects.
4. Decide on the Repurpose work on `code/beautiful-cori-1zfk11`. It changes `screen.tsx`, which this slice changed, so merging it needs conflict work.
5. Backend unification, not started: one run record, one ledger, one approval path, one provider router, one planner, one publish door.
6. Calibration is still its own page.
7. Confirm the owner's naming. The Factory screen is labelled "Ads".
8. The line of record (which branch is the release line) is an open owner decision.
