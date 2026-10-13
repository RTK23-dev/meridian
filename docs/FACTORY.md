# Content Factory: run settings, stop points and approvals

This is the Factory as it works in this release. The plan it follows is [NORTH_STAR.md](NORTH_STAR.md) sections 4 and 5. Where this
document and that plan differ, the plan is the target and this file says what is built.

## One settings model

A brand has defaults. Each Factory run has its own settings, which are the brand's defaults with the run's overrides laid over them.
A run stores the settings it started with, so a later change to the brand does not change a run already in progress.

| Setting | Values | Meaning |
| --- | --- | --- |
| `automation` | `manual`, `semi`, `full` | Where a run waits for a person (see the stop points below). Default `manual`. |
| `decisionEngine` | `workspace_default`, `jev`, `openai-decisions` | Which engine decides. Default `workspace_default`. |
| `intent` | `organic`, `ad`, `both` | Which publish path and which metrics. Default `organic`. |
| `formats` | `image`, `video`, `carousel` (one or more) | What the run makes. Default `video`. |
| `platforms` | for example `instagram`, `facebook`, `youtube`, `tiktok` | A platform with no connection is reported as not connected. |
| `providers` | per format: `auto` or a provider id | `auto` lets the capability matrix choose. A named provider that is not ready stops the run with its reason. |
| `caps` | `dailyCents`, `totalCents`, `maxVariants` | Spend caps and the variant limit. See the caveat on caps below. |

The server checks every value. An unknown automation, intent or format, a platform id that is not lowercase letters, a provider id
outside the allowed pattern, or a negative cap is refused with the reason. Nothing is coerced.

The three older vocabularies map onto `automation`:

| Old value | Becomes |
| --- | --- |
| Factory level 0 or 1 | `manual` |
| Factory level 2 | `semi` |
| Factory level 3 | `full` |
| Studio `manual`, `semi_automatic`, `fully_automatic` | `manual`, `semi`, `full` |
| Brand brain `manual` or `assisted` | `manual` |
| Brand brain `automated` | `semi` (a decision made in code; the owner can change it) |
| Brand brain `autonomous` | `full` |

The owner ceiling and the verified test-account round trip still apply. They are checked against the level the mode is held to:
`manual` is 1, `semi` is 2 and `full` is 3.

## Stop points

Every run has the full stage graph. The mode decides where a stage waits (`factory/stage-decision.ts`):

| Stage | `manual` | `semi` | `full` |
| --- | --- | --- | --- |
| Discover, ingest, decode, grade, trend, pick, template, gate | runs | runs | runs |
| Produce (spends), launch (publishes), test (shifts budget) | waits for approval | waits for approval | runs inside the cap |
| Review | waits for approval | runs | runs |

- **The kill switch stops every stage in every mode**, approved or not. The run is marked `paused` with the reason.
- **A stage that waits is not a failure.** The run is marked `awaiting_approval` with the reason, and it continues from that stage once
  approved.
- **`full` with no spend cap stops** before any spend or publish, with the reason "Full automation needs a spend cap". It does not run
  unbounded.

## Approving a stage

A person who is a member of the brand approves a waiting stage with the server function `approveFactoryStage` (run id, brand id and one
of `factory.produce`, `factory.launch`, `factory.test`, `factory.review`). The approval is recorded once per run and stage. The stage
and every stage after it are queued again in order, so the run carries on from the point it waited.

The Factory screen shows an **Approve** button on a run that is waiting at one of these stages. The button is shown only to a member, and
only where the server would accept the approval: a paused or stopped run has nothing to approve, because it needs its spend cap or the kill
switch cleared first. The server function remains the way to approve from a script.

## Spend caps

A run is held to the stricter of its own cap and the brand's cap in `factory_spend_caps`, counting only the caps that are set. Each
cap is checked two ways: a total over the run, and a daily total over the last 24 hours. Spend is the metered rows in
`factory_costs` for the run. A spend or publish stage is refused with the reason before it runs, in every mode, when either cap is
reached. Produce checks the caps again before each provider call, so the call that would pass the cap is never made.

`full` also needs a cap to be set. A `full` run with no cap stops before any spend, with "Full automation needs a spend cap".

A metered row is written only from a provider call that reported its own cost (`factory_costs.basis` is `provider_reported`). A
provider that reports no cost writes no row, and the caps cannot see its spend. The Google image provider reports no cost today, so a
Factory run that uses it is not counted against its caps. Its reservation is still held in the budget ledger, at the per-image
ceiling of $1 (`FACTORY_IMAGE_CEILING_USD`), and settles at that ceiling. That ceiling is a guard, not a price.

## Produce

Produce materializes each variant of the run for each format the run makes, through the production router
(`src/lib/meridian/factory/produce.ts`):

- Only images are produced. A run whose formats include video or carousel stops at produce, before any spend, with that reason. The
  video path completes asynchronously through the poller, and the Factory does not wait on it yet.
- The provider is the run's choice for the format. `auto` lets the capability matrix choose. A named provider that is not configured
  or not connected stops the run, and the run row carries the provider's reason. No other provider is used in its place.
- The budget is reserved before the provider is called. A call that returns a failure releases the reservation. A call that does not
  return keeps its reservation held. Nothing releases a held reservation on its own, including when the submission expires. An admin
  releases it on the Factory screen, in the Held budget panel.
- The image is stored, judged and recorded by the materializer that Studio uses. The creative is in `creative_records`, its review is
  in `reviews`, and `factory_creatives` links it to its run and variant. Library and Reviews read it from there.

The gate stage reads the JEV `creative_qa` record for each creative. That record holds the text questions and the visual questions
(`creative.visual_quality.v1` and `creative.product_visible.v1`). The engine answers once, when the image is judged, so the gate does
not ask again. A variant with no creative, or whose creative has no recorded decision, is review. An engine that is not configured,
or whose thresholds are not calibrated, routes to review in that record, so the gate never passes it.

## What grading uses

The grade stage scores each ad from what the source reported. The Meta Ad Library collector requests the ad's stop time and the countries
it reached, and stores them with the ad. An ad whose stop time is absent is still delivering as of capture. An ad collected before this
release has no stop time stored, so its delivery is unknown.

- Unknown delivery, track record and quality contribute nothing to the score. The range widens and the evidence names what is missing.
- Days running run from the first sighting to the last. An ad is not counted as running up to today.
- The advertiser's track record is the share of its ads, among those with a known delivery, that are still delivering.

Beside the observed signal, each ad gets a JEV grade. The run's engine answers five grading questions through the engine gate:
`market.competitive_strength.v1`, `production.reproducibility.v1`, `creative.brand_fit.v1`, `brand.positioning_fit.v1` and
`safety.policy_risk_level.v1`. The grade is stored in the `jev_*` columns of `ad_timelines`, next to `winner_score`, with the engine, the
model and the question versions it was asked under. The two are never blended into one number.

The thresholds of the first two questions are not calibrated. Their specs mark them `thresholdCalibration: "uncalibrated"`, so every
probability they return goes to review, whatever the engine reports. The other three thresholds are the registry's existing values. The
engines report their answers as uncalibrated today, so those route to review as well. Nothing approves on an uncalibrated threshold.

With no engine ready for the workspace, the row says `graded on observed signal only: no decision engine configured`. An ad that the same
engine has already graded with the same questions is not asked again.

## Pick and plan

Pick chooses what to make next from the graded ads. A concept is an angle, hook type and format from the ad's creative DNA. The brand's
brain filters out a concept it cannot judge, or one that uses a word the brand avoids. Each concept is weighted by the patterns the brand
has learned, and ranked with a Thompson draw seeded by the run id, so a run's picks reproduce. The picks are stored in `factory_picks`.

Plan turns each pick into a CreativePlan for the brand's product, made under the engine decision the ad was graded under. A pick with no
such decision, or no product, gets a storyboard and no plan, and the reason is recorded on the run. The control takes its hook type,
angle and format from the winning ad's framework, never its words. Each variant changes one attribute (hook, angle, format, proof or CTA)
to a line the brand wrote in its brain, and records that attribute in `tests_attribute`. A brain field with no line gives no variant.

## When a run finishes

A run is finished only when the learn stage does its real work. Learning is not built yet, so a run that reaches the end of the
graph stays `running`, and the run row says `learn:not-built`. No other stage marks a run finished. Review counts the variants that
wait for a person and leaves the run where the stop points put it. A run that waits at a stop is `awaiting_approval`, and a run the
kill switch stops is `paused`.

## Not built yet

Work-queue items 8, 9, 10 and 11 of NORTH_STAR section 8 are open, and item 6 covers images only. In short: produce does not yet
materialize video or carousel; publish and measure both paths are not built; learning is not per surface; and the Factory screen does
not show the run settings or the approve action. Uploads are not connected to Gather. See [ROADMAP.md](ROADMAP.md).

## Waiting and stopping

A stage that waits, or a run that is stopped, holds the stages after it. Each of those stages returns without running, and the run
keeps the stage it stopped at. A stage that is stopped by a cap, the kill switch or a provider that is not ready records the reason on
the run row. A person approves a waiting stage, and the stage and the stages after it are queued again. Nothing queues a stopped stage
again on its own: once its reason is cleared, the run must be started again. The Factory screen has no control for that yet.

## Gather

The discover stage runs the sourcing stack for one run (NORTH_STAR section 5, step 1). It reads the brand's website and the websites of
its confirmed competitors. A page is read by the crawler, and a social post or profile link is read by the social scraper. The registry
adapters search the run's niche on the run's platforms, and the Meta Ad Library collector stores the ads that grading reads. The run's
platforms are its `platforms` setting; with none chosen, every platform the niche search covers is reported.

Each source records one state on the run, in `factory_run_sources`:

| State | Meaning |
| --- | --- |
| `ok` | The source ran. `items` is what this run stored from it. Zero is a real result. |
| `not_connected` | No key is saved, or no page or link is saved for it, or no adapter exists for the platform. The reason says which. |
| `failed` | A call raised an error or the scraper could not read the link. The reason is the error text. |

A source that is not connected or fails does not stop the run. Items go to the evidence tables that already exist: `research_ads` for
Ad Library ads, `discovered_items`, `sources` and `discovered_page_evidence` for pages and posts. Uploads are `not_connected`, because no
upload intake stores a swipe file yet. The Factory board lists each recent run's states in `runSources`.
