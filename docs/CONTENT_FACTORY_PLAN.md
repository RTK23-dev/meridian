# Content Factory: execution plan

Last checked 2026-10-22. This is the plan of record for the Content Factory. Product direction is in [NORTH_STAR.md](NORTH_STAR.md), and
how the Factory works today is in [FACTORY.md](FACTORY.md). Where this plan and NORTH_STAR disagree, NORTH_STAR wins.

## How to use this plan

- Take the lowest-numbered unfinished task in the lowest unfinished milestone.
- Name the task ID (for example `M1.2`) and the loop step (NORTH_STAR section 1) in every PR.
- Tick a task only when its acceptance test passes. A live task is ticked only when its run is recorded in
  [PHASE_LOG.md](engine/PHASE_LOG.md), with the artifact ids, the state and the cost.
- Agents hold no live keys. A live task is a runbook for the owner, and the agent never asks for a key.
- Stop at a decision marked in section 6. Do not pick an option for the owner.
- Paths are short. A path with no `src/` prefix is under `src/lib/meridian/`, except `engine/` (`src/engine/`), `routes/` and `components/` (`src/routes/` and `src/components/`). `docs/`, `scripts/` and `migrations/` are from the repo root.

## Status after the first execution pass (2026-10-22)

| Task | State | Commit | What is true now |
| --- | --- | --- | --- |
| M0.1 | done | `3f9094c` | NORTH_STAR and FACTORY corrected: Thompson and creative linkage are wired, the run carries the Page id and link, organic reads are implemented but unverified live. |
| M0.2 | done | `51d7558` | Studio starts from the brand's automation default (saved run defaults, else the brain level). Factory and Studio share the mapping. **Behaviour change:** a brand with no saved defaults and a manual brain starts Studio at manual; it started at semi-automatic. |
| M0.3 | done | `d3c11f0` | Button audit against the dev server: 273 controls and 22 dialogs, 0 failing. The one failure (a disabled Connect with no reason) is fixed. Screenshots not taken for that text-only change. |
| M1.1 | partly done | `b0bf80b` | `factory/loop.test.ts` runs one intent-both run from produce to learn. It does not cover discover, grade or pick (their suites do), nor the organic measured leg, which needs a connected channel. |
| M1.2 | blocked | — | The live paid request sends no creative to any platform, Meta included, so a TikTok or Google route would create half-built ads. See D14 and D15. |
| M1.3 | done, except D12 and one engine gap | `953d7da`, `277a6b6` | Higgsfield status and cancel use the documented path, not verified live. The webhook receiver is rate limited (300 a minute per client). Proxy headers are off by default. The Factory's artifact downloader checks public addresses and pins them; the artifact host allowlist is open by default (D12). **Engine gap:** `engine/gateway/download.ts` fetches any https URL a provider returns, with no public-address check. The key is safe: the gateway attaches credentials only on the provider's own host, so a returned URL gets none. The fix is to share the pinned, public-only download with the engine (a neutral module both sides import). It needs an eng-pipeline change, so I have not made it. |
| M1.4 | done | `9485ff7` | Typecheck exit 0, lint 0 errors, build exit 0. The full src suite ran: 6,054 tests, 6,012 passing, 41 skipped for environment reasons, 1 failing. The failure was the `.env.example` contract, fixed in `9485ff7` and re-run alone (9 of 9). The scripts suite: 160 of 160. |
| M2.0 | partly done | `live-readiness` | `npm run live:readiness` reports, for each key category in the credentials contract, whether its deployment variable is set and whether its shared default is opted in. It prints names and yes or no, never a value, and calls no provider. The live recorder that makes one call per step is not built. |
| M3.1 | done, no change | — | The four organic readers match their documentation. The endpoints, methods, scopes and fields were checked: Instagram Reels insights, Facebook video insights, TikTok video query, YouTube statistics. Instagram's insights call uses API version v25.0, and the documentation's example uses v26.0. Not verified live. |
| M3.2 | blocked on D19 | — | The paid insights request matches Meta's Ad Insights fields. The conversion count is not defined: it takes the first action whose type contains "conversion", so the count depends on Meta's order. See D19. |
| M3.3, M3.4 | blocked | — | Need the M2 live runs and D19. |
| M4.1 | blocked on D1 | — | |
| M4.2, M4.3 | blocked on D5 | — | M4.3 also needs M4.2. |
| M4.4 | design written; awaiting D16 to D18 | — | `docs/engine/PLAN_TO_REQUEST_BRIDGE.md`. Recommends Option 1, the engine accepting a plan run's outputs. That needs an engine contract change (D17). |
| M4.5 | blocked on D2 | — | |
| M4.6 | blocked on D3 | — | |
| M5.1 | blocked on D7 | — | |
| M5.2 | partly checked; decisions open | — | Two price tables exist. `factory/price-table.ts` holds one entry (OpenAI decision tokens). The engine's `engine/config/prices.ts` holds 26 priced entries and 9 null ones, and a null price refuses the call. On 2026-10-22 I read the vendor pages for three of them. **Deepgram Nova-3 monolingual, $0.0043 a minute:** confirmed, and Multilingual is $0.0052. **Gemini 3.8 Flash TTS, $9 a million output tokens:** confirmed through 2026-12-31, then **$18 from 2027-01-01**, which the table does not show. **Veo 3.1 Fast, $0.10 a second:** not confirmed, because neither Google's pricing page nor OpenRouter's listing states a price. See D1 and D20. |
| M5.3 | no change | — | ROADMAP records no documented lookup for the providers that lack one. |
| M5.4 | blocked on D4 | — | |
| M5.5, M5.6 | blocked on live runs | — | |

## The loop and where each step stands

The loop is Gather, Grade, Pick, Plan, Produce, Gate, Approve, Publish, Measure, Learn. Every step is built on recorded fixtures. None has
a recorded live run.

| Step | Code | Missing before the step is done |
| --- | --- | --- |
| Gather | `factory/gather.ts`, `factory/sources.ts`, `factory/instagram-volume.ts`, `research/worker.ts` (Ad Library) | Live calls for each source. The Apify key and plan price (D4). Uploads are not a source yet (D7). |
| Grade | `factory/grade.ts`, `decisions/gate.ts` | A live engine grade on record. Every probability routes to review until the brand is calibrated, and that is correct. |
| Pick | `factory/pick.ts`, `factory/thompson.ts` (wired) | Measured outcomes to weight with (M3). |
| Plan | `factory/plan.ts` | Nothing on fixtures. A variant with no brain line gives no variant, by design. |
| Produce | `factory/produce.ts`, `produce-image.ts`, `produce-video.ts`, `produce-engine.ts`, `produce-carousel.ts`, `security/held-reservations.ts` | Live provider calls. Held-budget lookups (M5.3). The engine render price (D3). The choice of default video path (D6). |
| Gate | `factory/gates.ts`, JEV `creative_qa`, `jobs/licensed-uris.ts` (engine) | `ENGINE_LICENSED_PROVIDERS` (D2). A live judgment on record. |
| Approve | `factory/stage-decision.ts`, `factory/actions.ts` | Studio does not read the run settings (M0.2). |
| Publish, organic | `distribution/service.ts`, `distribution/youtube.ts`, `facebook.ts`, `instagram.ts`, `tiktok.ts`, `storage/media-link.ts` | Live receipts. The TikTok audit (D10). Instagram graduation is not observable. |
| Publish, paid | `factory/publish.ts`, `publishing/engine.ts`, `providers/live.ts`, `providers/ad-account.ts` | The Factory's paid path is Meta only (M1.2). A live paid publish (D10). |
| Measure | `measurement/pull.ts`, `measurement/creative-linkage.ts`, `performance/` | Every live read is unverified (M3). |
| Learn | `factory/learn.ts`, `learning/calibration-report.ts`, `learning/calibration-gate.ts` | Outcomes. Calibration needs 100 measured outcomes per question per brand (M3.4). |

The brief page at `/content-factory` makes one video through the engine. It is a producer inside Produce, reached through the `engine`
provider. The engine's own edit, compose and render steps are not connected (M4.4).

## Milestones

### M0. Make the record true (no keys)

- **M0.1. Correct the stale claims.** NORTH_STAR section 3 says Thompson and creative linkage are "not wired". Both have callers
  (`factory/pick.ts`; `factory/actions.ts` and `measurement/pull.ts`). NORTH_STAR section 8, item 9, says organic channels return null
  from `fetchMetrics`. All four implement it. FACTORY.md's Publish section says a run carries no Facebook Page id and no destination link.
  The run settings and the run builder carry both, and `factory/publish.ts` reads them. Files: `docs/NORTH_STAR.md`, `docs/FACTORY.md`.
  *Accept:* every claim in those files matches the code, and the diff is reviewed.

- **M0.2. Studio reads the run settings (NORTH_STAR section 8, item 2).** Map Studio's `autonomy` and the brain's `automationLevel` to
  `automation` with the table in FACTORY.md. Read the run settings in Studio. Keep the old fields readable until every stored value is
  migrated. Files: `schemas/studio-generation.ts`, `creative/plan.ts`, `studio/session.server.ts`,
  `routes/_app/brands/$brandId/studio.tsx`, `components/studio/plan-dialog.tsx`, `components/studio/generate-step.tsx`,
  `schemas/brain.ts`, `brand/brain-store.ts`, `factory/run-settings.ts`.
  *Accept:* a Studio test changes `automation` and the stages change, as `factory/stage-flow.test.ts` does for the Factory. A test reads a
  stored old value. The brain's `automated` to `semi` mapping is a code decision the owner can change (D13).

- **M0.3. Button audit on the Factory screens.** Run `npm run ui:button-audit` against the dev server (`scripts/button-audit.mjs`). Fix
  any control that does nothing, or state why it cannot act.
  *Accept:* the audit's result is recorded in PHASE_LOG.

### M1. Prove the whole loop on fixtures (no keys)

- **M1.1. One run through all ten steps.** A new test, `factory/loop.test.ts`, runs one brand's run through every step with
  `intent: both`, on `runtime-mode.ts` with the test providers (`providers/media.ts`, `publishing/engine.ts`).
  *Accept:* one organic receipt and one paused-ad receipt per creative. Both metric paths write rows with a creative id and a surface.
  Learning writes one pattern per surface, and the next run's Pick reads them. The run reaches `succeeded` only at learn, with a measured
  outcome, as FACTORY.md's "When a run finishes" says.
  Optional: extend `scripts/product-loop.mjs` for the Factory run page, as NORTH_STAR section 7 asks.

- **M1.2. TikTok and Google on the Factory's paid path.** The Factory's paid route is Meta only (`factory/publish.ts`). Add the TikTok and
  Google routes through `providers/live.ts`, with the saved ad account (`providers/ad-account.ts`).
  *Accept:* fixture tests for each platform. Each refuses in the same order as Meta: no stored token, no targeting country, no
  destination. Nothing is set to ACTIVE.

- **M1.3. Security follow-ups (code parts).**
  - The Higgsfield status path (`production/providers/higgsfield.ts`) was derived from mocks. Confirm it against Higgsfield's documentation.
    If the documentation cannot be read, leave the path and mark it unverified in the file.
  - Limit the webhook edge (`routes/api/webhooks/receive.ts`): a rate limit and a body cap. Keep the existing signature checks.
  - The trusted-proxy setting is read in `security/limits.ts`. Its default must stay off.
  - Add an allowlist for the hosts that provider output URLs are fetched from.
  *Accept:* a test for each item. AGENTS.md rule 3 applies: no change to scoring, JEV, auth or provider logic beyond what this item names.

- **M1.4. Gate.** Run the full src suite once, with the owner's approval because of its token cost. Run typecheck, lint and build.
  *Accept:* all green, and the results are recorded in PHASE_LOG.

### M2. First live loop, one provider per step (owner runs; no keys in the repo)

- **M2.0. Live recorder.** A script, `scripts/live-run.mjs` (new), makes one call for a named step. It reads the key from the owner's
  environment and writes the artifact id, the state and the cost to a log that PHASE_LOG can cite. With no key it reports `not_connected`
  and calls nothing.
  *Accept:* with no key, every step reports `not_connected`, and no step reports success.

- **M2.1. Gather.** The Meta Ad Library (`research/worker.ts`) and YouTube, then SerpAPI, through `factory/gather.ts`.
  *Accept:* each source has a recorded row, and a source with no key shows `not_connected`.

- **M2.2. Grade.** One JEV engine on a few ads (`factory/grade.ts`, `decisions/gate.ts`).
  *Accept:* the stored grade names its engine, model and question versions, and an uncalibrated threshold routes the ad to review.

- **M2.3. Produce.** One image provider (`production/image-providers.ts`) and one video provider (`produce-video.ts`, with a provider from
  `production/providers/`). Each records its bill: either the provider's reported cost or a dated price entry (`factory/price-table.ts`).
  Then the engine path (`produce-engine.ts`), if D3 is set.
  *Accept:* a creative in Library and Reviews, and a row in `factory_costs` with its basis.

- **M2.4. Gate.** JEV `creative_qa` on the creatives from M2.3.
  *Accept:* a judgment is recorded, and the gate reads it.

- **M2.5. Publish, organic.** YouTube first. Confirm the upload visibility default, which ROADMAP lists as "public". Then Facebook Page.
  Instagram and TikTok follow once their tokens and the media host are set (`MEDIA_LINK_SECRET`, a public `APP_URL`, and
  `TIKTOK_VERIFIED_MEDIA_DOMAINS` for TikTok).
  *Accept:* a receipt with the platform's id. A TikTok private post is recorded as unconfirmed.

- **M2.6. Publish, paid.** A paused Meta campaign to a test ad account (`factory/publish.ts`, `providers/meta.ts`). Needs D10.
  *Accept:* the campaign, ad set, creative and ad exist, all paused, each recorded in `provider_objects`.

- **M2.7. Measure.** One organic pull per channel, and one paid pull (`measurement/pull.ts`).
  *Accept:* each metric row has a creative id and a surface. An unknown value is `null`.

### M3. Close the measurement loop (owner runs; agent corrects the shapes)

- **M3.1. Organic reads.** Check each channel's `fetchMetrics` (`distribution/facebook.ts`, `instagram.ts`, `tiktok.ts`, `youtube.ts`)
  against the provider's documented response. Fix the shape errors that M2.7 finds.
  *Accept:* each channel has one recorded live pull that matches its documentation.

- **M3.2. Paid insights.** Check the reads in `performance/` against Meta's documented insight fields.
  *Accept:* one recorded live pull.

- **M3.3. Learn from real rows.** `factory/learn.ts` recomputes the patterns per surface. `learning/calibration-report.ts` shows the
  outcome count for each brand.
  *Accept:* the Calibration screen shows real counts. A pattern from a real win is visible at the next run's Pick (`pick-surfaces.test.ts`
  covers the logic).

- **M3.4. Thresholds stay as they are.** `learning/calibration-gate.ts` keeps every threshold uncalibrated until a brand has 100 outcomes
  for a question. Do not lower that number. Review the constants at that point (D11).

### M4. Engine media depth

- **M4.1. Veo replacement (handoff phase 0; D1).** The engine's Veo preview model shuts down on 22 October 2026. The Video Engine Bible
  requires the move before E1. No Veo provider exists in this repository.
  *Accept:* a current model is chosen and wired through the gateway (`engine/gateway/`).

- **M4.2. Window renderer (D5).** `engine/render/splice-run.ts` reports `not_connected` today, because no window renderer exists.
  Build the window render on `engine/render/hyperframesCloud.ts` or `shotstack.ts`, whichever D5 names.
  *Accept:* the executor renders one window and joins it with the splice (`engine/render/splice.ts`).

- **M4.3. Remake through the splice.** `engine/jobs/remake.ts` still re-renders the whole video.
  *Accept:* a remake renders only the changed window in a test, and the cost is recorded. Then one live remake, recorded.

- **M4.4. Plan-to-request bridge (design decision first).** The orchestrator's edit, compose and render steps are not connected, because the
  plan path carries no EDL and no voice timings. Write the design for the bridge in `engine/orchestrator/production.ts` and get the
  owner's approval before any code.
  *Accept:* the design is approved. Then each step is connected with fixtures.

- **M4.5. Licence port (D2).** `engine/jobs/licensed-uris.ts` reads `ENGINE_LICENSED_PROVIDERS`, which has no default.
  *Accept:* a take from an unlicensed provider is refused at the pre-render gate, with its reason.

- **M4.6. HyperFrames render (D3).** `engine/render/hyperframesCloud.ts` stays fail-closed until the price per minute is set.
  *Accept:* the price is in config, with its source and date, and one live render is recorded.

### M5. Operate at volume

- **M5.1. Uploads as a Gather source (D7).** Decide whether uploads feed Gather. Then make `factory/gather.ts` count them as a source with
  its own state, and align FACTORY.md and ROADMAP, which currently disagree.
  *Accept:* a run with uploads shows the upload source with a count, and with none shows `not_connected`.

- **M5.2. Priced ledger for every provider used.** Each provider either reports its bill, or has a dated entry in `factory/price-table.ts`
  read from its pricing page. Caps count only priced spend.
  *Accept:* `price-table.test.ts` covers each provider in use. A provider with neither is refused before its call.

- **M5.3. Held-budget lookups.** `security/held-reservations.ts` holds `SUBMISSION_LOOKUPS`. Register each lookup that a provider
  documents. Where none exists, the admin path stays, and the panel says so.
  *Accept:* a held reservation releases only when the provider's lookup confirms it holds no job.

- **M5.4. Instagram discovery volume (D4).** Set the Apify key and the plan price in `sources/apify/config.ts`. Until the price is known,
  the discovery cost is `null`.
  *Accept:* one recorded run within the weekly cap.

- **M5.5. Sleep mode.** `factory/sleep-actions.ts`. A full night inside its caps, with its report.
  *Accept:* the night finishes inside the caps, and the report matches the ledger.

- **M5.6. Shopify attribution.** `routes/api/webhooks/shopify.ts`, with a connected shop.
  *Accept:* one recorded order is attributed to its creative.

**Definition of done for the plan.** One brand's loop runs unattended for a week in `full` mode, inside its caps. Every step has a live
row. The Calibration screen reports numbers from measured outcomes. Learning changes what Pick chooses.

## Decisions that block tasks

The owner answers these. An agent reports the blocked task and does not choose an option.

| ID | Decision | Blocks |
| --- | --- | --- |
| D1 | Veo replacement. Google's Veo documentation says the Veo 3.1 Preview models in the Gemini API were shut down on 22 October 2026, which is today, and recommends Gemini Omni Flash or a GA Veo model. The engine routes `video.cinematic` and `video.budget` to `veo_3_1_fast` and `veo_3_1_lite` through OpenRouter. Its listing shows no status or price on the page I could read, so whether OpenRouter's Veo is still served is unknown. Gemini Omni Flash's listed effective price is about $0.10 a second of 720p video, which Google's page does not say includes audio. Check OpenRouter's `/api/v1/videos/models` before choosing. | M4.1 |
| D2 | `ENGINE_LICENSED_PROVIDERS`: which providers' outputs are licensed for commercial social use. An empty value licenses none. | M4.5, engine video at Gate |
| D3 | The HyperFrames price per minute, and the render fallback (Shotstack, or none). | M4.6, M2.3 (engine path) |
| D4 | The Apify key and plan price. | M5.4 |
| D5 | The window renderer for a splice remake: HyperFrames, Shotstack, or keep the full re-render. | M4.2 |
| D6 | The default video path for `auto`: the matrix's provider, or the engine. | M2.3, Produce's default |
| D7 | Whether uploads feed Gather. | M5.1 |
| D8 | The name of the brief page. Proposed: keep "Content Factory" for the loop and call the page "the brief page". | Docs and UI copy |
| D9 | Planner prompt v2 (`orchestrator_plan@2`), and whether the new `queued` node state falls under the contract rule. | Orchestrator plans |
| D10 | Per brand: the Facebook Page, the ad account, and the TikTok audit status. | M2.5, M2.6 |
| D11 | Calibration constants. Already accepted (NORTH_STAR section 9). Review them at 100 measured outcomes. | M3.4 |
| D12 | Deployment settings: `MERIDIAN_TRUST_PROXY_HEADERS`, the host allowlist, the webhook limits. | M1.3 (the deployment part) |
| D13 | Review item 7: whether embedding and email provider status should come from stored credentials, as the other providers' status does, or keep reading deployment variables. The code is unchanged. | Review item 7; M0.2's brain mapping (its `automated` to `semi` rule) |
| D14 | Which ad platform a run's paid intent uses. Proposed: Facebook and Instagram go to Meta, TikTok to TikTok, and YouTube to Google. The Factory's paid path is Meta only today, whatever the run's platforms. | M1.2 |
| D15 | Creative attachment for paid ads. The Factory's live paid request sends no media to any platform, Meta included. TikTok needs a video asset id, and Google needs an image or video. Approve the scope of uploading each approved creative to the ad platforms before any route to TikTok or Google is built. | M1.2, and the Meta paid path's creative |
| D16 | Which way the plan-to-request bridge goes (M4.4): Option 1, the engine accepts a plan run's outputs; Option 2, the orchestrator compiles its own EDL; or Option 3, production runs through the brief request. Recommended: Option 1. | M4.4 steps 1 to 4 |
| D17 | The engine contract change that Option 1 needs: a version bump, a Bible section 4 note, and the lead's approval. | M4.4 step 3 |
| D18 | The style kit for a plan run: named by the plan, or the brand's default page kit. | M4.4 step 4 |
| D19 | Which Meta action counts as a conversion. Today the first action whose type contains "conversion" is used, so the count depends on Meta's order. Proposed: a named action type per brand (for example `purchase`), and null when the account reports none of it. | M3.2, M3.4, and every paid conversion count |
| D20 | Update `src/engine/config/prices.ts` with dated sources. The config belongs to eng-contracts, so I did not change it. Three changes need a decision: the Gemini 3.8 Flash TTS rate doubles on 2027-01-01 and needs a dated schedule; the Deepgram entry should cite the vendor page read on 2026-10-22; the Veo entry is unconfirmed until D1 is answered. | M5.2, the speech and video budgets |

## Out of scope for now

- Engine phases E2 to E6, except the items named in M4.
- New sources beyond the registered adapters.
- Scoring, JEV and auth logic, unless a task names them.

## Verification at each gate

- Each task: its fixture tests, plus typecheck and lint on the files it changed.
- Each milestone exit: typecheck, lint and build.
- M1.4 and each release: the full src suite, once, with the owner's approval.
- Each live task: a row in PHASE_LOG.

## Keeping this plan current

When a task ships, tick it and link its commit. When a decision is answered, remove it from the table and note the answer under the task it
unblocks. When a test or a live run changes what is known, update the status table in section 2.
