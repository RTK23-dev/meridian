# Revamp: the setup guide, sourcing and the new look

This records what the revamp changed, the decisions made without the owner (so they can be reversed), and what is still open.
It sits beside NORTH_STAR.md. Where the two disagree on direction, NORTH_STAR.md still wins.

## What a new person now sees

1. **Sign in.** A split screen: the loop Meridian runs (Gather, Grade, Make, Publish, Learn), where keys live, and that new paid
   ads start paused. The form sits on the right and stacks first on a phone.
2. **Overview.** One callout names the next setup step and why. It disappears once the two required steps are done.
3. **Setup guide (`/setup`, first item in the sidebar).** Six steps in order. Each one says what it is, why it matters, and what
   the saved records show now. Only the first two are required.
   - **Create your first brand.** A name and what you sell. Everything else is folded under "Add more detail".
   - **Choose a decision engine.** Two cards: TypeSafe JEV and OpenAI Decisions, with what each does and what key it needs. A
     card that is not ready carries its own key form, so the key is saved where the choice is made. Only the chosen engine
     receives decisions, and nothing falls back to the other one.
   - **Pick where examples come from.** Public web pages and your own files need no key. Meta Ad Library, YouTube and search
     take a key each. The rest sit under "More connectors".
   - **Make images and video.** Optional. Gemini and Hypit rows, with a note that uploads cover the gap.
   - **Publish your work.** Optional. Regular posts go to a Facebook Page, Instagram or YouTube account. Paid ads go to Meta or TikTok, created paused, and Meridian has no switch to turn them on. Either one completes the step.
   - **Connect Google Drive.** Optional. A server setting, so it names the variables rather than offering a form.
4. **Settings → General** still shows every provider row with its reason. The guide links there.

The guide reads the same server states as Settings, through `src/lib/setup/facts.ts` and `src/lib/setup/guide.ts`. It never
reads a key and never calls a live provider. An unknown state is shown as "could not be checked", not as "to do".

## Sourcing: what the reader does and does not do

Public page reads (the crawler, the Market "public page" run and the research snapshots) now:

- read the site's `robots.txt` first, for the crawler's own name (`MeridianBot`) and then for `*`, using the longest-match
  rule of RFC 9309. A missing file allows the read. A file that cannot be read at all refuses it for now. The answer is cached
  per origin for an hour (`src/lib/meridian/sources/crawl-policy.ts`, `fetch-page.server.ts`);
- send a truthful User-Agent, `MeridianBot/1.0`, instead of none;
- report a bot check (a CAPTCHA, or a Cloudflare or other challenge page served with 403, 429 or 503) as a plain refusal that says
  what to do instead: upload the page or use a connected source.

Meridian does not try to solve CAPTCHAs, pass Cloudflare challenges, rotate identities or otherwise get past a bot check. That
is a line in this product, not a gap to fill later. Where a source offers an API or a licence, use that. Where it does not, the
person uploads what they have the right to use.

## Paid ads, created paused

Paid ads are optional, and Meta, TikTok and Google Ads are each optional. Meridian creates campaigns, ad sets and ads with the status
`PAUSED` (`providers/meta.ts` for Meta; TikTok and Google follow the same rule). The only status-changing function in the codebase,
`setMetaStatus`, has no caller, so nothing in Meridian switches an ad on. The Library's "Paid ads, created paused" card uses
`PausedExplainer` to say so in three steps, and it names the platform rather than assuming Meta. If an automatic switch-on is
added later, this text must change with it.

## Regular content and paid ads from the Library

Each creative in the Library has a **Publish** action for members. It opens the same dialog as Studio, which lists the connected
destinations in two groups: regular posts (Instagram Reels, Facebook Page, YouTube Shorts) and paid ads. A person chooses one or
more, and the dialog shows a receipt for each. Only connected destinations can be chosen. Nothing is published from a card until
the person confirms in the dialog. TikTok regular posts are not in this build: they need a TikTok Content Posting adapter, which
does not exist yet, so the dialog does not offer them.

The deployment status line on Integrations no longer reads "No live publishing API is implemented". Publishing is set per channel,
so the line says that and points to Connected accounts.

## Design

- The palette, type (Fraunces for headings, Inter for text) and the reduced-motion rule are unchanged. The body has a soft warm
  light behind the page.
- Motion is limited to three entrances: a short rise for cards and steps, a fade for page changes, and a staggered loop on the
  sign-in screen. Progress bars and hover lifts use a transition. `prefers-reduced-motion` shortens every one of them to 0.01ms,
  and zeroes the animation delays too, so a staggered element is never held hidden. The overview's pipeline stages have no
  entrance: a fade on data that arrives late ran during the UI baseline's contrast scan and failed it.
- Section labels on the brand screens use the shared `.eyebrow` class (small, muted, uppercase) instead of bold brass caps. That
  is 27 labels across 13 files. The Factory tabs have the same spacing below the tab bar as Settings.
- The overview's advertising pipeline has one progress track above its ten stages. Its percent comes from `stageProgressPercent`,
  which is tested.
- Light and dark themes keep the existing token pairs.

## Removed

- The Grok platform tooling: the PWA head plugin, its install page and assets, the server middleware, the og.grok.me brand check,
  the write-atomic staging helper, the preview process manager, the og-skill fixtures and `docs/legacy/GROK_AGENTS.md`.
- Variables that only fed the Grok plugin: `VITE_GROK_EXTENSIONS`, `VITE_PROJECT_ID`, `VITE_PUBLIC_HOSTNAME`, `X_CREATOR`.
- The local env override moved from `.grok/app-env.json` to `.meridian/app-env.json`. The mechanism is unchanged.
- The home page's seven-step checklist and its model (`src/lib/onboarding.ts`). Its review and competitor steps are on their own
  screens, so nothing is lost; the overview now points at setup.
- The prompt registry's `grok-4.5` model names are now `provider-default`, because no prompt is bound to a model yet.
- SQL migrations were not edited. Old Grok comments inside them stay as history.

## Decisions made without the owner

1. **One branch and one draft PR** for this revamp, on the designated branch, reset to `main` because its only extra commit was
   already in `main`.
2. **The overview callout replaces the checklist** rather than sitting beside it.
3. **The brand form keeps all its fields,** folding the optional ones, so no saved data is lost.
4. **Google Drive stays a server setting** in the guide, not a form, because the server shares one Drive across workspaces.
5. **Publishing is optional, and no platform is required.** Meta and TikTok paid ads each complete the step alone. Regular posts need only a connected account. The export package works without any of them.

## Not done, and why

- **The `e2e` failure on `main`** at the brain save is fixed in this PR, in three commits. `7f4fd33` and `00a099c` pre-bundle the
  dev server, which removes a reload and a start-up race. `6a4808c` removes the autosave condition from the Save brain button,
  which disabled the click the product loop made. CI on `6a4808c` passes `check`, `ui-smoke` and `e2e`.
- **Google Drive video notes.** The owner's screen recording could not be read: the Drive connector returns only its title for
  video. Requirements in this document come from the owner's written message.
- **Live sourcing against real sites** was not run from this environment. The robots and bot-check rules are tested with fixtures.
- **Setup against a live Meta, YouTube, TikTok or Google account** was not run. Each key is the owner's to verify (NORTH_STAR
  section 7).

## Open questions for the owner

- Should a site that answers with a bot check be retried later, or kept as a permanent "blocked by site" note?
- Which decision engine should be the default for new workspaces: TypeSafe JEV, OpenAI Decisions, or no default at all?
- Should the paused-ad explainer link to Meta Ads Manager directly, or stay as text?

## Screenshots

Captured at 1280 px wide from one fixture account, with the same steps before and after. The setup guide is new, so it has no
before image. The phone images are at 390 px.

- Sign in: `docs/revamp-screens/before-login-desktop.png` → `after-login-desktop.png`, and `after-login-phone.png`
- Overview with a brand: `before-overview.png` → `after-overview.png`
- Library, publishing as paused ads: `before-library-paused.png` → `after-library-paused.png`
- Setup guide: `after-setup-desktop.png`, and `after-setup-phone.png`
- Factory line, with the tab spacing and the quieter labels: `before-factory.png` → `after-factory.png` (1440 px, from the UI
  baseline fixture)

## What was run for this change

- `npm run typecheck`: passes.
- `npm run lint`: 0 errors. The 6 warnings are in files this change does not touch.
- `npm test`: 1,952 tests, 1,911 pass, 0 fail, 41 skipped. The skipped tests need `MERIDIAN_PG_TEST_URL` (a Postgres admin
  connection), which this environment does not have.
- `npm run build`: passes. `db:migrate` skips without `DATABASE_URL`, and PGlite migrates itself.
- A browser pass over sign-up, workspace, brand, overview, library, settings and setup at 1280 px and 390 px. No page errors.
- `npm run ui:baseline`: passes locally, 28 routes and 280 captures, after the setup layout and contrast fixes. CI `ui-smoke` runs it on `6a4808c` and passes.
- `npm run e2e`: passes locally with the Save brain fix, unthrottled and with the page CPU throttled 4x (three of three runs). CI `e2e` on `6a4808c` passes.

## Still open after this change

- `.env.example` still lists the S3 variables. NORTH_STAR work item 1 retires S3 in code, settings and docs, so it is a separate change.
- `main` still has the brain-save failure until this PR merges. The fix is in this PR, not in `main`.
- The overview's "after" screenshot predates the progress track on the pipeline. A fresh 1280 px capture is still to do.
- Every screen was reviewed at 1440 px from the UI baseline fixture. Two were changed in this pass: Opportunities had a missing
  space between its two sentences, and the Intelligence tabs wrapped "Whitespace (0)" and "Semantic Memory" onto two lines on
  desktop. Both are fixed. The rest need work that was not done in this PR:
  - **Audit log** shows the generic "The request did not finish" error in the fixture. The list and count queries run cleanly
    on a minimal PGlite schema with the empty filters the page sends, the `memberships` table exists, and the dev server log
    holds only aborted requests. The cause is not reproduced. Open the error's Details in a running workspace to get the message.
  - **Settings** shows the decision engine and provider keys twice: once in the Setup panel and again under "Provider keys and
    settings". One of the two should go, and the other should link to the setup guide. Not changed here, because it moves
    save paths that have their own tests.
  - **Notification preferences**: "Refresh preferences" reads as plain text, not as a button.
  - **Products** uses the brand name as its kicker and has no eyebrow, unlike most brand screens.
  - **Market** and **Brand brain** are long single columns. Grouping them into tabs changes their save paths, so each is a
    separate change.
  - **Jobs and health**: the brand filter's select truncates "All brands and workspace jobs".
