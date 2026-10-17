# Feature screens: before and after

Status: partial. The before side is captured for every listed screen that exists at the PR base. The after side comes from
`code/beautiful-cori-1zfk11` at `91df2bf`, not from this branch, because this branch is at the base with no changes (see Sources).
The Studio publish dialog and two Factory details could not be captured (see Not captured).

## Sources

- **Before:** `d0e8f63` (origin/main, the PR base).
- **After:** `code/beautiful-cori-1zfk11` at `91df2bf` (detached worktree; no branch was changed). That branch holds all the listed UI
  changes: `theme pages`, the publish dialog, `setup-model.ts`, the Factory run builder, the sales panel and the sleep mode panel.
  The same commits also appear on `lead-b34-pages`, `lead-b56-attribution`, `lead-b12-discovery` and `lead-i-factory-engine-2`.
- This branch, `worktree-agent-aac37e64053be3dca`, is at `d0e8f63` with no commits of its own, so it shows none of the changes.

## Method

- `npm run dev` on port 8080 with the default PGlite database (no `DATABASE_URL`). One server ran at a time.
- Sign-in was left on, the documented local path. A fixture account, workspace and brand were created through the app's own sign-up
  flow (`feature-screens@meridian.invalid`, "Feature screens fixture"). This is fixture data, not a real account or brand.
- No provider key was set. Provider state shows as NOT_CONNECTED or "Not configured". No runs, variants, orders or creatives were
  created. The one interaction is a form choice in the run builder (the video provider select), which was not saved.
- Playwright with `/opt/pw-browsers/chromium`. Each screen is a viewport capture: `<id>-before.png` and `<id>-after.png` at 1280x800,
  and `<id>-before-phone.png` and `<id>-after-phone.png` at 390x844.

## Pairs

| Screen id | Where in the app | Before (`d0e8f63`) | After (`91df2bf`) |
| --- | --- | --- | --- |
| `pages-theme` | `/brands/<brand>/pages` | "Page not found": the route does not exist at the base. | Theme pages: "Pages this brand publishes from", an empty state, "New page" and "Create first page". The description mentions the Instagram trial reel default. |
| `factory-run-builder-engine` | Factory, Discover, Start a run, Video provider | The provider field is a text input. The option cannot be chosen, and the capture shows the field unset. | The Video provider select offers "Meridian video engine". Chosen, it shows the engine's explanation and what stops a run. |
| `factory-run-builder-formats` | Factory, Discover, Formats and Provider per format | The Video provider field sits under Provider per format. | The same area. The field is a select with the engine option. |
| `factory-run-builder` | Factory, Discover, Start a run | "Video engine: NOT_CONNECTED (hypit)". | The same engine status line. |
| `factory-discover` | Factory, Discover | The Sources list, with the sources shown as NOT_CONNECTED. | The same list. The B2 tier counts appear only on a run with Instagram candidates (see Not captured). |
| `factory-learnings` | Factory, Learnings | The weekly strategist report only. | "Sales by reel": "No Shopify shop is connected", the webhook address, a shop domain field and a "Connect shop" button. |
| `factory-learnings-sleep` | Factory, Learnings, Sleep mode (top of the panel) | No sleep mode panel. The page ends at "Continue to Reviews". | "Sleep mode is off", an unchecked "Turn sleep mode on", night time (03:00), time zone (UTC), niche, "Save sleep mode", and "No night has run yet. The first morning summary appears here." |
| `settings-setup` | Settings, General, Setup | "17 not configured, of 17 rows". | "22 not configured, of 22 rows". The apify and shopify rows are defined in `setup-model.ts` on the after side and sit below the frame. |
| `factory-pipeline` | Factory, Factory Line (default tab) | Context only. | Context only. |
| `studio` | Studio, step 1 | Context only. This is not the publish dialog. | Context only. This is not the publish dialog. |

## Not captured

- **Studio publish dialog** (`src/components/studio/publish-dialog.tsx`, the Instagram trial option). It opens from a stored variant in Studio
  step 4. The fixture has 0 stored variants, and no media provider is connected. A variant would have to be invented, so nothing is
  captured, either before or after.
- **B2 gather tier counts** (`src/components/factory/run-list.tsx`). They appear only on a run that has Instagram candidates. Without an
  Apify key the source is not connected, nothing is gathered, and no candidate exists.
- **B5 orders per reel.** No Shopify shop is connected, so no orders show. Only the not-connected state of the sales panel is captured.

## Content Factory (`/content-factory`)

- **Before:** `6bf831f` (main), exported with `git archive` and run with `npm run dev` on port 8092 and a fresh PGlite database.
- **After:** this branch, `npm run dev` on port 8091 with its own fresh PGlite database. No provider key and no Drive credential were set.
- A fixture account, workspace and brand were created through the app's sign-up flow ("Feature screens fixture"). For the session
  capture, one session ("Fixture session (screenshot only)") with two instructions (a brief, contract v8) was created through the screen. Recaptured on main 899aa33.
  Playwright with `/opt/pw-browsers/chromium-1194`. 1280x800 and 390x844 viewport captures; `-full` is a full-page capture.

| Screen id | Before (`6bf831f`) | After |
| --- | --- | --- |
| `content-factory` | "Page not found": the route does not exist at the base. | Content Factory in the workspace sidebar, the empty state and the new-session form (title, optional brand). |
| `content-factory-session` | Not available. | Chat on the left (messages with their role, composer, file attach and drop zone, "Attach from Meridian", the Drive not-connected line), video settings below it, and the Decisions panel: what the brief request still needs (reference video, theme page, length, budget, priority; no script or language), the engine's NOT_CONNECTED reasons, and "Make the video" disabled with its reason. Stacked on phone width. |

Not captured: a started run's decision feed. The engine is not connected here (no monthly budget, no OpenRouter or render key), so no request can start, and a feed would have to be invented. The feed is covered by
`src/lib/meridian/content-factory/feed.test.ts` on a recorded engine run.
