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
  return keeps its reservation held. Nothing releases a held reservation on its own, including when the submission expires. An admin or owner
  releases it on the Factory screen, in the Held budget panel. Other roles see the panel's rule and the reason they cannot release it.
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

The patterns that weight a concept are the run's own surface's. An organic run reads organic patterns and an ad run reads paid patterns.
A run with intent `both` makes creatives for both surfaces, so each concept has two arms, an organic arm weighted by organic patterns and
a paid arm weighted by paid patterns. A pattern on one surface never moves the other surface's arm. The concept is picked once, on the arm
whose draw ranks first, and the pick records that surface in `factory_picks.surface`. See [Learning per surface](#learning-per-surface).

Each pick also records the JEV grade its ad carried, as a fingerprint in `factory_picks.grade_fingerprint`. The grade itself is not copied:
it stays in `ad_timelines`, with its engine, model and question versions. The fingerprint is how the run view knows whether that grade is
still the one the pick was made under (see [Predictions and outcomes](#predictions-and-outcomes)).

Plan turns each pick into a CreativePlan for the brand's product, made under the engine decision the ad was graded under. A pick with no
such decision, or no product, gets a storyboard and no plan, and the reason is recorded on the run. The control takes its hook type,
angle and format from the winning ad's framework, never its words. Each variant changes one attribute (hook, angle, format, proof or CTA)
to a line the brand wrote in its brain, and records that attribute in `tests_attribute`. A brain field with no line gives no variant.

## When a run finishes

A run finishes at its learn stage, and only when that stage finds a measured outcome of the run's own creatives. Learning recomputes the
brand's patterns per surface (see [Learning per surface](#learning-per-surface)) and counts the outcomes of the run's creatives on each
surface. When there are some, the run is `succeeded`. When there are none, the run stays `running` and its row says `Learning waits for a
measured outcome from this run's creatives`. Learning runs once in the queue, before the six-hourly measurement pull has stored anything, so a
waiting run is checked again with **Check learning again**, which the run offers only while it is running at its learn step. No other stage
marks a run finished. Review counts the variants that
wait for a person and leaves the run where the stop points put it. A run that waits at a stop is `awaiting_approval`, and a run the
kill switch stops is `paused`.

## Publish

The launch stage sends each approved creative of the run down the paths its `intent` names (`factory/publish.ts`). A creative is
approved when a person approved it, or the policy did, and its gate result is not `block`. An unapproved creative is counted in the
launch summary and is never sent.

- **Organic** (`organic`, `both`): each platform the run names goes through `distribution/service.ts`. A platform with no organic
  channel is reported. A run with no platforms lists every organic platform, so each one shows its own state. A channel with no usable
  connection records `not_connected` with its reason, and sends nothing. It is never counted as published. A post is recorded in
  `organic_posts` with surface `organic`.
- **Paid** (`ad`, `both`): the campaign, ad set, ad creative and ad are created with status PAUSED, and each is recorded in
  `provider_objects` with surface `paid` and status `paused`. In the testing runtime the fixture engine in `publishing/engine.ts` answers.
  Outside it, a paid publish needs a stored Meta token and a targeting country. A Factory run does not carry a country yet, so the
  publish is refused with that reason. Nothing in the Factory sets an ad or a campaign to ACTIVE.
- **Receipts:** `organic_posts` and `provider_objects` both carry a `surface` column (migration 0069). A failure is recorded as a
  receipt with no external id, so a retry can publish the creative again without overwriting a confirmed object.

The test stage records what a budget test would do, and it waits for a person in every mode. The audit log keeps the record. Nothing is
switched on.

The export package for a creative is its listing in Postgres (`distribution/export-package.ts`). It depends on no connection, so it is
there for every creative. This build writes the listing only. It copies no files to Drive and no route serves it yet.

## Measure

The launch stage schedules `measurement.pull` for the run, every six hours, when it has a receipt to measure. The pull reads the run's
published organic posts and its paused paid ads (`measurement/pull.ts`):

- **Organic metrics** come from the channel's `fetchMetrics`. Every live channel returns null, so an organic pull with no fixture stores
  nothing and reports that the metrics are not connected.
- **Paid metrics** come from the workspace's stored token through the insights reader. Without a stored token, nothing is measured. The
  test publisher has no insights source.

Every metric row goes through `recordLinkedMetric` (`measurement/creative-linkage.ts`). The row is stored in
`unified_performance_telemetry` with its creative id, its surface in `source_type`, and the external id of its receipt. A row with no
creative id, no surface, or no receipt of that surface is refused. A paid metric is never written for an organic receipt, and the
reverse. A metric the source did not report is null, never zero. A repeated pull of the same observation stores nothing twice.

The Factory board shows each creative's receipts and its measured rows. A metric that was not reported reads "not reported".

## Learning per surface

Learning keeps each pattern on one surface: `organic` (organic posts and their metrics) or `paid` (paused ads and their metrics). A pattern
also names a channel, a platform such as `tiktok`, or `''` for every channel of its surface. The surface follows from the metric, and each
metric is measured on one surface only: click-through, conversion and return are paid, and three-second retention, completion and shares are
organic. Migration `0070` gave each existing pattern its surface this way. A pattern whose metric names neither surface is `unassigned`,
Pick never reads it, and the next recomputation replaces it.

Every recomputation rebuilds the brand's patterns from the stored outcomes: the learn stage, the telemetry sync and the organic bridge. The
outcomes are `performance_observations` (paid) and `organic_observations` (organic). The telemetry sync fills those tables from the measured
rows in `unified_performance_telemetry`, which is where a Factory creative's measurements are stored. A paid observation is written only from
a row whose source is paid. Before this release an organic row that carried an impression count was written as a paid observation.

Pick reads a pattern only when it is on a surface the run makes creatives for, and on a channel the run names, or on every channel. An
organic win never moves a paid run or a paid arm, and a paid win never moves an organic run or an organic arm. A run with intent `both`
reads both surfaces, each for its own arm (see [Pick and plan](#pick-and-plan)). The test `pick-surfaces.test.ts` seeds an organic win and a
paid win that disagree, runs the learn recomputation, and checks that each pattern is produced and that each arm reads only its own.

## Predictions and outcomes

A pick is a prediction: the grade its ad carried says how the engine judged the concept before anything was made from it. The grade is stored
once, on `ad_timelines`, with its engine, model, question versions and action. A pick stores the fingerprint of that grade at the time it was
picked (`factory_picks.grade_fingerprint`). The fingerprint is a hash of what the engine answered, so it changes when the engine, model,
questions, policy, action or gate record changes.

The run view reads the ad's grade now and compares it with the stored fingerprint:

| Status | Meaning | What the view shows |
| --- | --- | --- |
| `same` | The ad still carries the grade the pick was made under. | The grade, as the prediction the pick was made under. |
| `regraded` | The ad was graded again after the pick, by another engine or with other questions. The earlier grade is not kept. | The current grade, and a note that the ad was graded again. |
| `unrecorded` | The pick was written before fingerprints were stored. | The current grade, and a note that the prediction is not known. |

A missing engine is shown as "Not graded", with the reason the grade gives. It is never shown as a score. The measured rows of the creatives
a pick's variants produced are shown beside the pick. A metric the source did not report reads "not reported".

Migration `0071` adds `factory_picks.surface` and `factory_picks.grade_fingerprint`. Picks written before it have `''` in both, and the
view says so rather than guessing. The prediction an earlier pick was made under is kept only while the ad is not graded again.

## The Factory screen

The Discover tab has two parts. **Start a run** is the run builder. It has the niche, automation, intent, decision engine, formats, platforms,
a provider per format, the daily and total spend caps and the variant limit. It starts from the brand's run defaults. It says in plain words
what must change before the run can start; for example, full automation needs a total cap above zero. Each run stores the settings it started
with, and the server checks them again.

**Runs** lists each run with its settings, its stage progress, each source's state, and the receipts and measurements of its own creatives.
Under **Run details** it also lists **Grades and variants**: each pick of the run with its concept, its surface, the grade it was made under
(see [Predictions and outcomes](#predictions-and-outcomes)), its plan status, its measured rows, and each variant with the one attribute it
tests, its gate result and the creative it became, with that creative's receipts and measured rows.

Its controls:

- **Approve**, on a run waiting at a stage a person approves. Members only.
- **Start again from** the stage, on a paused run. Members only. It is disabled, with the reason, while the kill switch is on.
- **Check learning again**, on a running run at its learn step. Members only.

Viewers see the runs, their grades and variants, and the reason they cannot act. The run view is read through `getFactoryBoard`, which checks
that the brand belongs to the caller's workspace, and every row it reads is scoped to that workspace and brand (`factory/run-view.ts`).

## Not built yet

What is left after work-queue items 10 and 11 (NORTH_STAR section 8):

- Video and carousel production. A run whose formats include video or carousel stops at produce, before any spend, with that reason.
- Learning is not re-run on a schedule. The learn stage runs once in the queue, and a waiting run is checked again only with its Check learning
  button.
- Cross-surface proposals: an organic winner proposed as an ad test, or the reverse. A run with intent `both` learns each surface for its
  own arm, but no pattern on one surface is proposed as a test on the other.
- A re-grade overwrites the grade of record on `ad_timelines`. A pick made under the earlier grade can no longer show that grade, only that
  the ad was graded again. Keeping every grade needs a grade history table, which is not built.
- Organic outcomes are still one observation per post. A later organic measurement of the same post is not added to `organic_observations`.
  The paid path is per measurement (see [Learning per surface](#learning-per-surface)).
- The Factory screen was not checked in a browser from this branch. Its before and after screenshots, and the button audit, need a run of
  the app that this change did not make.
- The Factory Line editor (prompts, grading thresholds, presets) is saved for the brand, but no job reads it yet. The screen says so.
- The owner's running level and ceiling are still set in Live tests with the older levels, not with run settings.
- Live Instagram and TikTok publishing is not connected, by the owner's decision. A live paid publish from a run needs a targeting country the
  run does not carry.
- Uploads are not connected to Gather.

See [ROADMAP.md](ROADMAP.md).

## Waiting and stopping

A stage that waits, or a run that is stopped, holds the stages after it. Each of those stages returns without running, and the run
keeps the stage it stopped at. A stage that is stopped by a cap, the kill switch or a provider that is not ready records the reason on
the run row. A person approves a waiting stage, and the stage and the stages after it are queued again. Nothing queues a stopped stage
again on its own. A paused run has a **Start again** control on the Factory screen. It queues the stage the run stopped at and every stage after it, and it is refused while the kill switch is on. A spend cap that is still reached stops the run again, at the same stage, with the same reason.

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
