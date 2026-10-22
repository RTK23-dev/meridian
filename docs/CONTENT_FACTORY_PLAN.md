# Content Factory plan

Date: 2026-10-22. Status: proposal for the owner's review. Nothing in this plan is built, and this file is not committed.

Basis: [NORTH_STAR.md](NORTH_STAR.md) (sections 1 to 8), [FACTORY.md](FACTORY.md), [ROADMAP.md](ROADMAP.md),
[engine/CONTENT_FACTORY_STATE_2026-10-18.md](engine/CONTENT_FACTORY_STATE_2026-10-18.md), and a code check on 2026-10-22 for every
claim in section 3 and section 4. No tests were run for this plan.

## 1. The target

```
Gather → Grade → Pick → Plan → Produce → Gate → Approve → Publish → Measure → Learn
   ↑                                                                         │
   └─────────────────────── patterns pick the next round ────────────────────┘
```

Binding owner decisions (NORTH_STAR section 2):

- Agents hold no live keys. "Not connected" is a correct state, not a bug.
- Postgres is the system of record, Google Drive holds artifacts, S3 is retired.
- Ads and organic posts are both first-class, and the loop learns from both.
- Every source feeds one evidence store. The JEV grading engine is a core path.
- Providers are options. The person chooses, or the capability matrix does.
- Choice everywhere: automation mode, decision engine, intent, format, platform, provider.
- A live path is not done until a live run is recorded with its ids, costs and output.

Working rules for every PR (NORTH_STAR section 6): name the loop step and the work-queue item; add no module that nothing calls; unknown
is `null`; keep one decision path; keep tenancy and role checks on every server function.

## 2. Two names, one loop

"Content Factory" names two things in the code and the docs:

- **The Factory loop.** The run builder and run view at `/brands/:id/factory`. This is the product NORTH_STAR describes. This plan
  means this when it says "the Factory".
- **The brief page.** `/content-factory`. A chat-style session that makes one video from a brief through the video engine. It is a
  producer inside the loop, not a second product. The Factory's `engine` video provider calls it through `factory/produce-engine.ts`.

Proposal (decision D8): keep both, and call the page "the brief page" in the docs and the UI copy.

## 3. Where the loop stands

"Built" means built and tested on recorded fixtures. "Live" means a live run has been recorded. Live is empty for every step.

| Step | Built | Live | Gap |
| --- | --- | --- | --- |
| Gather | Each run's sources record a state: `ok`, `not_connected` or `failed`. Crawler, social scraper, registry adapters, Meta Ad Library collector, Apify Instagram volume, Cyclone scout. A missing key is `not_connected`, and the run goes on. | No source has a live call on record. | Apify key and plan price (D4). Uploads (G6). |
| Grade | Observed signal and five JEV questions, stored side by side. Caps and the kill switch are checked before each engine call. | No engine call on record. | Every probability routes to review until a brand is calibrated (100 measured outcomes per question). |
| Pick | `factory/pick.ts` uses Thompson (`factory/thompson.ts`, wired). Brain filters, per-surface weights, picks stored with their grade fingerprint. | None. | Nothing to weight with until outcomes are measured (G2). |
| Plan | One-attribute variants against a control. Hooks and CTAs come only from the brand's brain. | Not applicable. | A variant with no brain line gives no variant. This is intended. |
| Produce | Image, carousel and video through the router. Budget reserved before each call. Held-budget panel. `engine` video provider. | No provider call on record. The engine render is not connected: the HyperFrames price is unset. | No provider lookup for held budget (G9). Two video paths (G7). |
| Gate | Rule gates, JEV `creative_qa` and `visual_qa`, licence and AI-label records. | No judgment on record. | `ENGINE_LICENSED_PROVIDERS` is the owner's (D2). |
| Approve | Stop points by mode (`manual`, `semi`, `full`), approvals, the kill switch, Start again. A `full` run with no cap stops. | Not applicable. | Studio does not read these settings (G4). |
| Publish, organic | Facebook, Instagram, YouTube and TikTok through `distribution/service.ts`. Media links signed for 15 minutes. | None. | TikTok apps are unaudited: posts stay private and receipts unconfirmed. Instagram graduation is not observable. |
| Publish, paid | Meta paused campaigns. Destination (Page id and link) and targeting countries come from the run's settings. | None. | The Factory's paid path is Meta only (G3). |
| Measure | Organic reads for all four channels through `fetchMetrics`. Paid insights. Creative linkage (wired, `measurement/pull.ts`). Unknown is `null`. | None verified. | Every read is unverified against live data (G2). |
| Learn | Patterns per surface. Cross-surface proposals. JEV predictions stored beside outcomes. Calibration report. | None. | No measured outcomes exist, so nothing learns and nothing calibrates (G2). |

## 4. Corrections to our own docs

The check found these. M0 fixes them.

1. NORTH_STAR section 3 says Thompson and creative linkage are "not wired yet". Both have callers: `factory/pick.ts`, and
   `factory/actions.ts` with `measurement/pull.ts`.
2. FACTORY.md (Publish) says a Factory run carries no Facebook Page id and no destination link. The run settings and the run builder
   carry both, and `factory/publish.ts` reads them. What is still missing is a live paid publish, which needs the owner's run.
3. NORTH_STAR section 8, item 9, says organic channels return null from `fetchMetrics`. All four organic channels implement it
   (`distribution/facebook.ts`, `instagram.ts`, `tiktok.ts`, `youtube.ts`). Their reads are unverified live.
4. NORTH_STAR section 8, item 2, requires that Factory and Studio both read the run settings. Only `brands/$brandId/factory.tsx` does.
   Studio still takes `autonomy` (`schemas/studio-generation.ts`), and the brain keeps `automationLevel` (`schemas/brain.ts`).
5. NORTH_STAR section 8, item 1, is partly done. No S3 client code remains in `src`. The S3 mentions left are comments that record the
   retirement, and the Video Engine Bible, which CLAUDE.md lists as a known conflict. Remove the comments that only describe S3 and
   leave the Bible to the owner's decision.

## 5. Gaps, ranked by what they block

Each gap names the step it blocks and whether the owner has to act.

**G1. No live run of any step (blocks everything).** Owner runs. The agent builds a recorder: for each live step, a script that reads
the owner's key from the owner's environment, makes one call, and writes the artifact id, the state and the cost to a log that
PHASE_LOG can cite. No key enters the repo. Owner: yes.

**G2. Measurement is the first link fixtures cannot prove.** Organic reads on four channels, paid insights and the outcome counts are
unverified against live data. Without them, Learn has no input and calibration never starts. Fix: check each read against the provider's
documented response, record one live pull per channel, and check that the Calibration screen counts the outcomes. Owner: yes.

**G3. The Factory's paid path is Meta only.** The publishing engine has paid paths for TikTok and Google (`providers/live.ts`), and
NORTH_STAR names all three. Fix: route the Factory's paid path through the same destination and refusal rules for TikTok and Google,
with fixtures. Saved ad accounts are already in place (Phase 1, `b5288ae`). Owner: only for the live run.

**G4. Studio is not on the run settings.** North Star item 2 is not met for Studio. Fix: map Studio `autonomy` and the brain's
`automationLevel` through the table in FACTORY.md, read the run settings in Studio, and keep the old fields readable until every stored
value is migrated. Owner: no. The mapping is already decided.

**G5. No test drives a whole run.** NORTH_STAR section 7 asks for the loop to run in `TestingRuntime` on both publish paths and both
measurement paths, and names `scripts/product-loop.mjs` as the place to prove it. I did not find a test that drives one Factory run
through all ten steps. The item tests cover pieces of it. Fix: one test that runs one brand's run through every step with
`intent: both`, and asserts one organic receipt, one paused-ad receipt, both metric paths and one pattern per surface. Owner: no.

**G6. Uploads.** FACTORY.md says Gather records uploads as `not_connected`. ROADMAP says research-ad uploads are counted. The brief page's
files are not Gather sources at all. Decision D7: should uploads feed Gather? Recommendation: yes, as a source with its own state, so a
swipe file counts. Owner: decision.

**G7. Two video paths.** The provider path (Hypit, Gemini Omni, Higgsfield, ManualCloud) and the engine path (`engine`). The orchestrator's
plan runs also queue video steps. Recommendation: keep the choice (NORTH_STAR decision 6), let `auto` pick a provider through the matrix,
and keep `engine` as a named choice. The engine is the only path that makes its own edit and render. Owner: decision D6.

**G8. Engine media depth is blocked.**
- The HyperFrames price per minute is unset, so the engine render is not connected (ROADMAP).
- No window renderer exists, so a remake re-renders the whole video. Splice execution is not built.
- The edit, compose and render steps of a plan are not connected, because the plan path carries no EDL and no voice timings. This needs
  a plan-to-request bridge, which is a design call.
- The licence port waits on D2.
- The Veo preview model shuts down today. No Veo provider exists in this repository (handoff phase 0, D1).

Owner: D1, D3 and D5. The bridge needs a design decision.

**G9. Held budget waits for an admin.** No provider lookup is registered in `SUBMISSION_LOOKUPS`. Every held reservation therefore waits for
an admin, and caps stay blocked until one does. Fix: register each lookup a provider documents (ROADMAP lists which providers have none).
Where none exists, keep the admin path and say so in the panel. Owner: no.

**G10. Live cost truth.** Caps count only priced spend. A provider that reports no cost is refused (images) or not counted. Video
estimates are held, not spent. Perception tokens have no price, and the price table has one model with an entry. Before the first live
spend, each provider used must either report its bill or have a dated price entry from its pricing page. Owner: confirm each reading, or
give a price.

**G11. Security follow-ups before live use.** The Higgsfield status path is derived from mocks and must be confirmed against its
documentation. The provider artifact host allowlist is open. The webhook edge needs a rate limit and a body cap. Deployments behind a proxy
must set `MERIDIAN_TRUST_PROXY_HEADERS`. The agent can do the code parts. The deployment settings are the owner's (D12).

**G12. Verification debt.**
- The full `src` suite has not run since 2026-10-21 (the owner's instruction). It must run at the release gate.
- The button audit (`npm run ui:button-audit`) has not run on the Factory changes.
- The Studio publish dialog and the B2 tier counts have no screenshots.
- The brief page's revision and the hot swap have not been checked in a browser.
- Review items 1 to 6, 8, 10 and 11 have no new tests (`REVIEW_2026-10-22.md`).

**G13. Discovery volume and cost.** The Apify plan price is unknown, so the discovery cost is `null`. The weekly volume cap is an initial
value. Owner: D4.

## 6. Owner decisions

| ID | Decision | Unblocks |
| --- | --- | --- |
| D1 | Veo replacement. The model shuts down on 22 October 2026, which is today. The engine Bible requires the move before E1. | Handoff phase 0, E1 |
| D2 | `ENGINE_LICENSED_PROVIDERS`: which providers' outputs are licensed for commercial social use. Empty licenses none. | Licence port, engine video in Gate |
| D3 | HyperFrames price per minute, and the render fallback (Shotstack or none). | Engine render, remake |
| D4 | Apify key and plan price. | Instagram discovery volume |
| D5 | Window renderer for a splice remake: HyperFrames, Shotstack, or keep the full re-render. | Remake cost and time |
| D6 | The default video producer for `auto`: the matrix's provider, or the engine. | G7 |
| D7 | Should uploads feed Gather. | G6 |
| D8 | The name of the brief page. | Docs and UI copy |
| D9 | Planner prompt v2 (`orchestrator_plan@2`), and whether the new `queued` node state falls under the contract rule. | Orchestrator plans |
| D10 | Per brand: which Facebook Page and which ad account, and the TikTok audit status. | Live publish |
| D11 | Calibration constants. Already accepted (NORTH_STAR section 9). Review them at the first 100 measured outcomes. | Calibration |
| D12 | Deployment security settings: `MERIDIAN_TRUST_PROXY_HEADERS`, the host allowlist, the webhook limits. | G11 |

## 7. Milestones

Each milestone names the North Star items it advances and its exit criteria. Live steps are the owner's to run.

**M0. Make the record true (agent, no keys).**
- Correct the four doc claims in section 4 (NORTH_STAR section 3 and item 9, FACTORY.md Publish, the S3 comments).
- Studio reads the run settings (G4). Item 2's acceptance is then met for both surfaces, proven by tests.
- Run the button audit on the Factory screens (G12).
- Exit: NORTH_STAR's status notes match the code, and item 2's test passes for Studio and the Factory.

**M1. Prove the whole loop on fixtures (agent, no keys).**
- The whole-run test (G5).
- TikTok and Google on the Factory's paid path, with fixtures (G3).
- The code parts of G11.
- The full `src` suite, run once at this milestone. The owner confirms the run, because of its token cost.
- Exit: one `TestingRuntime` run goes through all ten steps with `intent: both`, with receipts and patterns asserted; the full suite is green.

**M2. First live loop, one provider per step (owner runs; agent builds the recorder and the runbook; G1, G9, G10, G13).** In this order:
1. Gather: Ad Library and YouTube, then SerpAPI.
2. Grade: one engine (JEV) on a few ads. The stored grade must route to review.
3. Produce: one image provider and one video provider, each with a recorded bill. Then the engine path, if D3 is set.
4. Gate: JEV creative QA on those creatives.
5. Publish, organic: YouTube first (confirm the upload visibility default), then Facebook Page. Instagram and TikTok follow once the tokens and the media host are set.
6. Publish, paid: a paused Meta campaign to a test ad account.
7. Measure: one organic pull per channel, and one paid pull.
- Exit: every step has a recorded row (ids, cost, state) in PHASE_LOG. No step is marked live without one.

**M3. Close the measurement loop (owner runs; agent fixes the shapes; G2).** Scheduled pulls are verified. Creative linkage counts per surface. The Calibration screen shows the outcome count per brand. Patterns are recomputed from real rows and feed the next Pick.
- Exit: a brand with real outcomes shows its counts, and a pattern from a real win is visible at the next run's Pick. Thresholds stay uncalibrated until 100 outcomes per question. There is no shortcut.

**M4. Engine media depth (G7, G8).** Decisions D1, D3, D5 and D6. The plan-to-request bridge for edit, compose and render. The window renderer and splice execution. The licence port (D2). Remake mid-run and variants after a remake, wired end to end.
- Exit: one shot's remake renders only the changed window, recorded live, with its cost.

**M5. Operate at volume (G6, G10, G13).** Uploads as a Gather source (D7). A priced ledger entry for every provider used (G10). Held-budget lookups (G9). A full sleep night inside the caps, with its report. Shopify attribution live.
- Exit: a sleep night finishes inside its caps, and the ledger matches each provider's bill within a tolerance the owner sets.

**Definition of done for the whole plan.** One brand's loop runs unattended for a week in `full` mode inside its caps. Every step has a
live row. The Calibration screen reports numbers from measured outcomes. Learning changes what Pick chooses.

## 8. Sequencing

- M0 and M1 need no keys. Agents can do them now.
- M2 is paced by the owner: each live step needs keys. The agent prepares the runbook first.
- M3 needs M2's publish and measure steps, and a few weeks of outcomes. Calendar time is the constraint here, not code.
- M4 needs D1 (today), D3 and D5.
- Calibration comes last by design. It needs 100 measured outcomes per question per brand.

## 9. Risks

- **Live APIs differ from fixtures.** Each live step may fail on its first call. The Higgsfield path is already suspect. Run one step at a
  time, and record every failure.
- **A small brand may never reach the calibration floor.** Its grades then stay in review, and the review load is the cost. The owner sets
  the volume per brand, and the Calibration screen shows the progress.
- **Spend can run ahead of the estimate.** Some providers bill later. Close G10 before any live spend.
- **The Veo model shuts down today.** Decision D1.
- **TikTok posts stay private until the app is audited.** Treat their receipts as unconfirmed.

## 10. Rules for executing this plan

- One PR per work-queue item, each naming its loop step.
- Agents write fixture tests for their own changes. The full suite runs at M1 and at each release gate.
- Typecheck, lint and build run at each milestone exit.
- No live key enters the repo or a log. The owner keeps keys in Settings or on the deployment.
