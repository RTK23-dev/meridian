# North Star: what Meridian is for

People running Meridian should start with the [README](../README.md). This file is the product direction for anyone changing the code.
It says what the owner is trying to build, which decisions are already made, how the existing code maps onto the goal, and
what to build next, in order. When this file and another document disagree about direction, this file wins. The numbered
rules in `ARCHITECTURE_CONTRACTS.md` still hold. The dated build record is under [engine/](engine/PHASE_LOG.md). It is not the product guide.

## 1. The product in one paragraph

Meridian is a content and advertising factory that learns. It **gathers** what is working in a niche (ads and regular
posts, from every source it can reach), **grades** it with the TypeSafe JEV grading engine (or OpenAI Decisions), **makes**
new content for the brand's products in the format the person chose (image, video or carousel; organic post or paid ad)
with the generation provider the person chose, **publishes** it, **measures** what happened, and **learns** from both organic
and paid results so the next round is better. Every step can run manually, semi-automatically or automatically.

The loop, which every piece of work must serve:

```
Gather → Grade → Pick → Plan → Produce → Gate → Approve → Publish → Measure → Learn
   ↑                                                                         │
   └─────────────────────── patterns pick the next round ────────────────────┘
```

The **Content Factory** is the heart of the product: it is this loop running as staged jobs. Studio is the same loop for
one creative at a time, steered by a person.

## 2. Owner decisions (binding)

These were decided by the owner. Do not reopen them in code, docs or PRs.

1. **No live keys for agents.** Agents never receive YouTube, Meta, TypeSafe, OpenAI, Gemini or any other key, and never
   ask for one. Many integrations are intentionally not set up yet. Build and verify against documented contracts with
   fixtures (section 7). "Not connected" is a normal, correct state, not a bug to fix.
2. **Storage is Postgres and Google Drive.** Postgres is the system of record; Drive holds artifacts and exports.
   **S3 is retired.** Remove S3 code, settings and docs; do not add other object stores.
3. **Both ads and regular content.** Meridian publishes organic posts and paid ads, and learns from both. Neither is a
   later phase of the other.
4. **Gather everything it can.** The crawler, the social scraper, the source adapters, the research collector and uploads
   all feed one evidence store. More sources are added behind the same adapter interface.
5. **The JEV grading engine must work.** Grading through TypeSafe JEV (and OpenAI Decisions as the alternative engine) is
   a core path, not an optional extra. Factory grading must use it.
6. **Generation providers are options.** Gemini Omni is one video provider among several (Higgsfield, Hypit, image
   providers, manual upload, and others later). The person chooses a provider or lets the capability matrix choose. No
   provider is hard-wired as the only path.
7. **Choice everywhere** (section 4): automation mode, decision engine, intent (post or ad), format, platform and provider.
8. **The Content Factory must keep getting better.** The stages are built and tested on recorded fixtures. A live path is not done until a live run is recorded. What is still open is [ROADMAP.md](ROADMAP.md). Do not mark a live provider done without that run, and do not invent its result.

## 3. What already exists, mapped to the loop

The pieces are mostly built. The work is wiring them into one loop, not inventing new subsystems.

| Loop step | Existing code to build on                                                                                                                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gather    | Crawler `discovery/crawler.ts` and `discovery/service.ts` (budgeted crawl, frontier, per-source states) · social scraper `sources/scraper/social-scraper.ts` · adapters `sources/registry.ts` and `sources/adapters/*` · Meta Ad Library collector `research/worker.ts` · Cyclone scout `discovery/cyclone-scout-adapter.ts` · uploads `sources/adapters/upload.ts`         |
| Grade     | JEV questions `jev/questions.ts` and `jev/questions/*` · engine gate `decisions/gate.ts` (`runEngineGate`) with JEV and OpenAI engines · research analysis with JEV `research/analyzer.ts` · creative DNA `factory/decode.ts`, `factory/creative-dna.ts` · concept genome with observed breakout `factory/concept-genome.ts` · ad survival signal `factory/winner-score.ts` |
| Pick      | clusters and momentum `factory/trends.ts` · opportunity ranking `opportunity/*` · Thompson allocation `factory/thompson.ts` (not wired yet) · learned patterns `learning/engine.ts`                                                                                                                                                                                         |
| Plan      | storyboard from DNA `factory/template.ts` · creative plan (source of truth for production) `creative/plan.ts`, `creative/engine.ts` · brief gate `studio/brief-gate.server.ts`                                                                                                                                                                                              |
| Produce   | provider router and capability matrix `production/router.ts`, `production/capability-matrix.ts` · durable materialization with budget reservation `production/materialization.ts`, `production/poller.ts` · providers `production/providers/*` (omni, higgsfield, hypit, manual-cloud) and `production/image-providers.ts`                                                  |
| Gate      | originality, claims, rights, policy, brand `factory/gates.ts` · JEV creative and visual QA `jev/questions/creative.ts`, `studio/image-qc.server.ts`                                                                                                                                                                                                                         |
| Approve   | reviews `reviews/*` · calibration gate (uncalibrated scores only route to review)                                                                                                                                                                                                                                                                                           |
| Publish   | organic: `distribution/service.ts` (`publishCreativeToChannels`; Facebook Page, YouTube Shorts) · paid: `publishing/engine.ts` and `providers/live.ts` (paused Meta, TikTok and Google campaigns) · the manual export package from the Library                                                                                                                              |
| Measure   | paid insights `performance/*` · organic `distribution/service.ts` (`recordOrganicTelemetryAndLearn`), `organic/learning-bridge.ts` · creative linkage by receipt `measurement/creative-linkage.ts` (not wired yet)                                                                                                                                                          |
| Learn     | attribute patterns `learning/engine.ts` · organic bridge `organic/learning-bridge.ts` · calibration `learning/calibration-report.ts`, `learning/calibration-gate.ts`                                                                                                                                                                                                        |

## 4. Choices: one settings model

Today there are three separate automation vocabularies that do not talk to each other:

- brand brain `automationLevel`: `manual | assisted | automated` (`brain.ts`), stored but enforced nowhere;
- Studio plan `autonomy`: `manual | semi_automatic | fully_automatic` (`schemas/studio-generation.ts`, `creative/plan.ts`);
- Factory level `0 | 1 | 2 | 3` (Suggest, Produce, Stage, Run) (`factory/autopilot.ts`, `factory/pipeline.ts`).

Replace them with one **run settings** object. A brand has defaults; each Factory run or Studio plan can override them.

| Setting               | Values                                            | Notes                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automation`          | `manual`, `semi`, `full`                          | manual: a person approves every step that spends or publishes · semi: the system runs every step and stops for a person before publish or spend · full: runs end to end inside caps; gates and the calibration gate still block |
| `decisionEngine`      | `workspace_default`, `jev`, `openai-decisions`    | defaults to the workspace engine; contract 2 still applies (one engine per decision, no fallback)                                                                                                                               |
| `intent`              | `organic`, `ad`, `both`                           | decides which publish path and which metrics                                                                                                                                                                                    |
| `formats`             | `image`, `video`, `carousel` (one or more)        |                                                                                                                                                                                                                                 |
| `platforms`           | e.g. `facebook`, `instagram`, `youtube`, `tiktok` | a platform with no connection is listed as not connected, never hidden                                                                                                                                                          |
| `provider` per format | `auto` or a provider id                           | `auto` = the capability matrix chooses; a named provider that is not ready stops the run with the reason                                                                                                                        |
| `caps`                | daily and total spend, max variants per run       | existing `factory_spend_caps` and budget ledger                                                                                                                                                                                 |

Mapping of the old values: Factory 0 = Gather and Grade only; 1 = up to Gate; 2 = up to a paused campaign or a draft post;
3 = `full`. Keep the stage graph in `factory/pipeline.ts`, but derive the allowed stages from the run settings.

## 5. Content Factory v2

The stage table that used to live here described the Factory before the 2026-10-15 build. It is no longer the current state.
What each stage does now, and what is still open, is [FACTORY.md](FACTORY.md). Section 8 below is the work queue and its status.

Target behaviour:

1. **Gather.** Run the existing sourcing stack for the run's niche, seeds and platforms: crawler, scraper, adapters,
   Meta Ad Library collector, uploads. Record each source's state (`ok`, `not_connected`, `failed` with reason) on the run.
   A source without a key reports `not_connected` and the run continues with what it has. Gather both ads and organic posts.
2. **Grade.** For each item, store two things side by side, never blended into one invented number:
   - the **observed signal**: for ads, survival from real sightings (days running, still running, variant count, countries);
     for organic posts, breakout against the creator's median (`concept-genome.ts`); `null` when the source gave no metric;
   - the **JEV grade**: `runEngineGate` with the run's engine on the grading questions (`competitive_strength`,
     `reproducibility`, `brand_fit`, `positioning_fit`, `risk_safety`). An engine that is not configured abstains; the item
     is then graded on the observed signal only, and says so.
3. **Pick.** Choose what to make next from graded concepts, filtered by brand fit, weighted by what the brand has already
   learned (patterns) and balanced between proven and untested angles with `factory/thompson.ts`.
4. **Plan.** Turn each pick into a `CreativePlan` (`creative/plan.ts`) for the brand's product: storyboard from the winner's
   DNA, then variants that each change **one** attribute (hook, angle, format, proof, CTA) against a control, so learning can
   attribute the result. Replace the fixed variant list.
5. **Produce.** Materialize plans through the production router with the run's provider choice. Budget is reserved first
   (contract 5). Factory output lands in the same creative tables Studio uses, so Library, Reviews and Publishing see it.
6. **Gate.** Rule gates plus JEV `creative_qa` and `visual_qa`. Missing evidence is review, never pass.
7. **Approve.** Follow `automation`: manual and semi wait for a person; full approves only what the policy and the
   calibration gate allow, inside caps. The kill switch stops everything.
8. **Publish.** `intent: organic` goes through `distribution/service.ts`; `intent: ad` goes through `publishing/engine.ts`
   (created paused, activated per `automation`); `both` does both, with separate receipts. The export package is always
   available. A platform that is not connected says so (contract 7).
9. **Measure.** Pull organic metrics (views, watch time, shares, comments, saves) and paid metrics (impressions, clicks,
   spend, conversions) and link every row to its creative through its publish receipt (`measurement/creative-linkage.ts`).
   Unknown stays `null`.
10. **Learn.** Update patterns from paid and organic outcomes, kept per surface (`organic`, `paid`) with the same attribute
    genome, so an angle that wins organically can be proposed as an ad test and the reverse. Store every JEV prediction
    next to the outcome it predicted, so calibration can be computed later.

## 6. Rules for agents

1. Every PR names the loop step it advances (section 1) and the work-queue item it closes (section 8).
2. Do not add a module that nothing calls. Wire it or do not merge it.
3. Do not start another audit-and-hardening round unless a work-queue item needs it. Correctness fixes on the path you
   are changing are welcome.
4. Never invent metrics, costs, receipts or connected states. Unknown is `null`; not connected is shown.
5. Keep one decision path (`decisions/gate.ts`). Fold overlapping `jev/` helpers into it when you touch them.
6. Keep tenancy and role checks on every server function, as today.
7. Run `npm test && npm run typecheck && npm run lint && npm run build` before finishing, and say plainly what could not run.

## 7. Verifying without live keys

- Every provider call goes through an injectable transport. Tests use fixtures shaped exactly like the provider's
  documented request and response, with the documentation link in a comment.
- The whole loop must run end to end in `TestingRuntime` with test providers (`runtime-mode.ts`, `providers/media.ts`,
  `publishing/engine.ts` test engine), including both publish paths and both measurement paths. Extend
  `scripts/product-loop.mjs` so it proves each new stage.
- The owner verifies live integrations personally, with keys saved in Settings, when each one is ready. Code should make
  that easy: a clear "not connected" state, and a single action in Settings that tests the connection.

## 8. Work queue, in order

Each item is one PR. Acceptance criteria are what the reviewer checks.

_Status notes below were added on 2026-10-15 from [engine/PHASE_LOG.md](engine/PHASE_LOG.md) and the code. "Done on fixtures" means
merged and tested on recorded fixtures. No criterion has been checked against a live provider. The notes change no criterion._

1. **Honesty and retirement.**
   Remove `storage/s3.ts`, the `S3_*` variables in `.env.example` and the S3 lines in `docs/PROVIDERS.md`.
   Replace the made-up Factory costs with costs read from the budget ledger, or none.
   In `learning/telemetry-engine.ts`, store missing metrics as `null`, do not merge `views` into `impressions`, and never
   create an `organic_posts` row marked `published` without a receipt.
   _Accept:_ no `S3` references outside the changelog; no fixed cost figures in `factory/worker.ts`; tests cover the null
   and no-receipt cases.
   _Status: partly done. `storage/s3.ts` is gone and `.env.example` has no `S3_` variable. Factory cost estimates were removed
   (CHANGELOG 0.1.0-beta.11), and telemetry stores an unknown impression count as null. The HyperFrames upload comment no longer names S3.
   Open: S3 is still named in comments that record the retirement, in `src/engine` and `src/lib/meridian/storage`.
   The no-receipt rule was not re-checked in this pass._
2. **Run settings.** One settings model (section 4) with brand defaults and per-run overrides, a migration, server-side
   validation, and the old three vocabularies mapped onto it.
   _Accept:_ Factory and Studio both read it; changing `automation` changes which stages run, proven by tests.
   _Status: done on fixtures. Nothing here waits on a live run or an owner decision._
3. **Factory Gather.** The discover and ingest stages call the real sourcing stack and record per-source states on the run.
   _Accept:_ in `TestingRuntime` a run gathers fixture items from at least the crawler, the scraper and the Ad Library
   collector; a source without a key shows `not_connected` and the run continues.
   _Status: done on fixtures. Each source records its state, and a source without a key is `not_connected` while the run goes on.
   Instagram volume through Apify is built on fixtures too. Waits for: the owner's Apify key and plan price (ROADMAP, owner items)._
4. **Factory Grade with JEV.** Observed signal and JEV grade stored side by side; fixed values removed.
   _Accept:_ with a fixture engine, grades are stored with engine, model and question versions; with no engine, items
   are graded on observed signal only and say so.
   _Status: done on fixtures. The grade stage checks the kill switch and both caps before each engine call. Waits for: a live decision
   engine, and measured outcomes before the thresholds of the first two grading questions can be calibrated._
5. **Pick and Plan.** Pick uses grades, patterns and Thompson allocation; Plan writes `CreativePlan`s with one-attribute
   variants against a control.
   _Accept:_ the fixed hook and CTA list is gone; each variant records the attribute it tests.
   _Status: done on fixtures. The Factory plan takes its hooks and CTAs only from the brand's brain (`factory/plan.ts`), and each variant
   records its attribute in `tests_attribute`. Waits for: nothing outside the code._
6. **Produce through the router.** Factory plans materialize through `production/materialization.ts` with the run's
   provider choice, into the shared creative tables.
   _Accept:_ Factory creatives appear in Library and Reviews; a named provider that is not ready stops the run with its reason.
   _Status: done on fixtures. Factory images, carousels and videos go through `production/materialization.ts`, and their creatives appear
   in Library and Reviews. A run can name the Meridian video engine (`engine`). Waits for: live providers and the owner's keys._
7. **Gate and Approve by mode.** JEV QA added to the gate stage; approval follows `automation`.
   _Accept:_ tests for each of manual, semi and full, including the kill switch and caps.
   _Status: done on fixtures. Tests: `stage-decision.test.ts`, `approval.test.ts` and `grade-cap.test.ts`. Waits for: nothing outside
   the code._
8. **Publish both paths.** Organic and paid publishing from the Factory and Studio, with separate receipts.
   _Accept:_ in `TestingRuntime`, `intent: both` produces one organic receipt and one paused-ad receipt per creative.
   _Status: done on fixtures (`publish.test.ts`). Waits for: live publishing. A live paid publish from a run is refused until the run has
   a Facebook Page id and a destination link, which is an open gap (FACTORY, Not built yet)._
9. **Measure both paths.** Scheduled organic and paid metric pulls, linked through `measurement/creative-linkage.ts`.
   _Accept:_ every metric row has a creative id and a surface; unknown values are `null`.
   _Status: done on fixtures. Each metric row is linked to its creative and surface (`recordLinkedMetric`), and an unknown value is
   null. Waits for: live metrics. Organic channels return null from `fetchMetrics`, and paid metrics need a stored token._
10. **Learn from both.** Patterns per surface; JEV predictions stored next to outcomes.
    _Accept:_ a test shows an organic win and a paid win each producing a pattern, and both feeding the next run's Pick.
    _Status: done on fixtures (`pick-surfaces.test.ts`). Waits for: live outcomes. A grading question's calibration needs 100 measured
    outcomes per brand (FACTORY, Calibration)._
11. **Factory screen.** A run builder that exposes every choice in section 4, and a run view showing each stage, each
    source's state, grades, variants, receipts and metrics.
    _Accept:_ every control acts or says why it cannot (`npm run ui:button-audit`).
    _Status: built, with before and after screenshots in `docs/feature-screens/`. Open: the PHASE_LOG records no run of the button audit
    for these changes, and the studio publish dialog and the B2 tier counts were not captured._

Items the code cites as B1 to B6 and I1 to I3 are not listed above. They are B1 and B2, discovery at volume and the outlier rater; B3, theme
pages; B4, Instagram trial reels; B5, sales attribution; B6, sleep mode; and I1 to I3, the Factory's engine integration (PHASE_LOG,
2026-10-15). All are built on fixtures, and their live gaps are in [FACTORY.md](FACTORY.md) and [ROADMAP.md](ROADMAP.md). The video engine's
phases E1 to E6 are in [engine/VIDEO_ENGINE_BIBLE.md](engine/VIDEO_ENGINE_BIBLE.md) section 19; each awaits its live run.

## 9. Owner decisions

The owner answered these on 2026-10-13. The answers are binding, and the code follows them.

- **Media for live Instagram and TikTok publishing.** A signed, short-lived link from the app, valid for 15 minutes. No link is
  signed unless the signing secret is at least 32 characters.
- **Held budget.** Released only when the provider confirms that no job exists for the submission. When the provider cannot be
  asked, the hold stays for an admin. No provider lookup is registered yet, so every hold stays for an admin until one is.
- **Grading thresholds.** Calibrated per brand from that brand's own measured outcomes. A calibrated threshold may only raise the
  bar, never lower it. Until a brand has enough outcomes, its grades stay uncalibrated and go to review. The first constants are
  accepted for now and will be reviewed once real outcomes exist.
- **Rights gate.** An operator attests each licence (music, footage) and confirms the AI label for each variant. Each record names
  who confirmed it and when, and each can be revoked.
