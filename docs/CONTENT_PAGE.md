# The Content page

Dated 2026-10-24. This is the reference for the one content page: what it is, how it is wired, what was checked, and what comes next.

## Status (2026-10-26)

The single Content page is part of PR #80 on `fix/openrouter-model-routing-jev`. The checkpoint commit hashes and paused-work notes from 2026-10-24 were historical and are not a description of this branch's current head. Use the current PR head and its CI run for release evidence; this document describes the current route/component layout and user-facing behavior.

## Name

The page is called **Content**. It was "Content Factory" until 2026-10-24. The owner-facing section previously called Ads is now **Batch**. Batch's primary subtab is **Video batches** for reference-and-research draft variations; the existing research-led production run is preserved under **Research-led runs (advanced)**. The engine's pipeline keeps the name Content Factory in its own docs and code (`src/lib/meridian/content-factory`). The route stays at `/content-factory`, so existing links keep working.

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
| Batch | Video batches (create video variations from one reusable source draft, group drafts, start under one budget) and, as an advanced tab, the research-led run builder (opens on Make a batch) | Admins only |
| Ideas | Ranked opportunities | Everyone |
| Review | Holds waiting for a person | Everyone |
| Library | Stored creatives | Everyone |
| Publish | Connected accounts | Everyone. The screen checks its own roles. |
| Results | Learning: patterns, performance, schedule, sharing | Everyone |

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

- **Earlier baseline:** [run 40263991449](https://github.com/RTK23-dev/meridian/actions/runs/40263991449), head `b4b94ea984caf9ab3b524fd2999a9f8fbb49678b`, passed all required jobs before the product-recovery PR. The Batch-first UI itself then passed all jobs in [run 40851115375](https://github.com/RTK23-dev/meridian/actions/runs/40851115375), including 25/25 release-browser checks. The reference-to-variation implementation has a separate current-head CI run; update this section with its final result before merge.
- The release-acceptance browser flow uses a fresh embedded database, a fixture-only sealed dummy token, and local browser requests. It checks stale provider readiness without probing a provider; the 25-hour-old Meta card reads DEGRADED, never HEALTHY or live-verified.
- The Content page browser checks passed for accessible workflow tabs, selected preset state, the no-brand empty state and phone-width overflow. Desktop and 390 px screenshots are attached to the same CI run.
- Live provider behavior, real credentials, paid calls, publishing and external side effects are intentionally not exercised.

## Remaining work and boundaries

- **Browser verification is complete on the recorded head** `b4b94ea984caf9ab3b524fd2999a9f8fbb49678b` in [CI run 40263991449](https://github.com/RTK23-dev/meridian/actions/runs/40263991449): the desktop/phone workflow checks, role-gated Batch tab, selected preset and local-only acceptance passed. A later code change must be rechecked on its own head.
- Keep the old section URLs as redirects and preserve URL-backed tab/preset/session state; these are compatibility behavior, not cleanup candidates.
- The Content page's Batch section remains admin-only. Its default subtab is Video batches. Research-led runs (advanced) preserves the previous Factory workflow, and its own first tab opens on Make a batch. Each underlying section keeps its server-side role checks.
- Repurpose upload proof is fixture-only and uses an injected fake transport. The paused-ad proof creates and reads back an ad as `PAUSED`; it never activates or publishes it.
- Live providers, credentials, paid requests and external publishing remain outside automated browser verification.
- Backend unification is not started: one run record, one ledger, one approval path, one provider router, one planner, one publish door.
- Calibration is still its own page.
- Line of record (which branch is the release line): owner decision.

## Video variations

A **reusable format** is a draft session with an uploaded reference video, at least one attached Market research record and a plain-language instruction (10 characters or more). **Create video variations** (Batch → Video batches) makes 2 to 20 original draft videos from it and groups them into one batch:

- Each new draft copies the source's instructions and attachments by value. The reference video is shared by its storage record; no bytes are copied. It gets one of 20 fixed, distinct structural angles. Every angle's instruction says to use the reference only for structure and pacing, to make new wording and visuals, never to copy footage, words, voice or music, and to leave out claims the evidence does not support.
- The batch budget is split exactly in cents. Each video needs at least the master cost floor (`MASTER_COST_FLOOR_USD`) and at most $1,000.
- The server refuses, and writes nothing, when the source is not an admin-accessible draft in a brand, has no uploaded reference file (a post link is not a video), has no Market attachment, has no plain instruction, or has hand-written script lines (a copy would repeat them word for word). The checks run again under the source row lock.
- Creating variations starts nothing: no engine request, no provider call. A person presses **Start the batch** after reading the list. The source stays unchanged and out of the batch (`createBatch` refuses a draft that videos were made from), so it can be used again. Each variation records its source (`source_session_id`) and angle (`variation_angle`).
- Not verified: no live run. The result is draft videos and their budgets, not finished videos.
- An identical request repeated within 20 seconds (a double click, a replay) returns the batch already made instead of making a second one. A changed count or total, or the same request later, makes a new batch.
- Batch reads one brand's sessions (up to 500, newest first). The workspace-wide list stays at 100, so a brand's older templates and drafts are not crowded out by other brands. Past 500 sessions in one brand, the oldest still drop out of the list.
- A batch shows its videos by state and can download a **batch summary (CSV)**: one row per video with its angle, the state the engine reports, the reason and the budget. The CSV holds no video file and no link, a video that is not delivered is never marked finished, and cells that start like a spreadsheet formula are prefixed so they stay text.

## Pattern-finding (the format found in your research)

The brand's analyzed ads already carry model labels for structure, opening move, hook mechanism and call to action, and Meridian stores how often each repeats (`research_patterns`). **What your research shows** (Batch → Video batches → Create video variations) reads those counts for the brand and shows them as "problem solution (4 of 9)".

- Needs at least 3 analyzed ads and a structure that at least 2 of them share. Otherwise it says why, and the videos use the fixed angles. "Other", "unclear" and "none" labels and free-text topics are left out.
- Ticking **Base the videos on these patterns** builds the first angles from the most common structure and opening pairs, most common first; the fixed angles fill any that remain. Asking for it when there is no format is refused with the reason and writes nothing.
- The angles use only the schema's label words and counts, never text from an ad. They still say to write new wording and visuals and never to copy footage, words, voice or music.
- These are counts of labels a model gave, so they are INFERRED. They show what is common, not what works. They are read per brand and per workspace; another brand's patterns are never used.
- Not verified live: the labels come from the existing analysis step, which has not been run against a live provider in this repository.

## Format sample, demo mode and export

- **Sample and approval.** Before the variations are made, the form shows a sample of the first video: its angle, its share of the budget, what it copies from the source, and the exact instruction it is given. Nothing is generated. The batch cannot be made until the person ticks "I have read the sample and approve this format", and the server refuses a request without that approval and writes nothing.
- **Demo mode.** **Try a demo batch** opens a batch of fixture videos (two "delivered", one draft) with no key, no provider and no cost. Every row is marked demo (`demo = true`), titled "DEMO (fixture)", and the page, the CSV and the manifest all say so. No video file exists for them. Hook history and economics leave demo rows out. A brand has one demo batch.
- **Export.** A batch downloads as a CSV summary and as a JSON manifest (`meridian.batch-manifest`): each video's position, title, angle, state, reason, approval, budget, attempts, engine request id and delivered manifest id. It holds no video file and no link, because a delivered file is read from its own video screen. Finished MP4s and captions are therefore not bundled here yet: that needs a live run to verify.

