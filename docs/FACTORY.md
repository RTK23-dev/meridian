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
| `targetingCountries` | ISO 3166-1 alpha-2 codes in capitals, such as `US` and `GB` | The countries a paid ad is targeted to. Empty means none is set. A live paid publish needs at least one. |

The server checks every value. An unknown automation, intent or format, a platform id that is not lowercase letters, a provider id
outside the allowed pattern, a negative cap, or a country code that is not an officially assigned ISO code (or is not in capitals) is
refused with the reason. Nothing is coerced.

A brand has run defaults, saved from the run builder with **Save as brand defaults** (an admin or owner). A run starts from them, and
each choice the builder changes is stored with the run. The defaults include the country list.

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

A metered row is written from one of two things, and its basis says which (`factory_costs.basis`):

- `provider_reported`: a provider call that reported its own cost in cents.
- `tokens`: a decision that called an engine and reported its token usage. Each decision writes one row for its run: the grade of an
  ad (`factory.grade`) and the judgment of a generated image (`factory.produce`). The row names the engine and the model and holds the
  prompt and completion tokens. A decision row is keyed by its gate record, so a rerun of a graded ad writes nothing.

A token row's dollar cost is written only when the price table (`factory/price-table.ts`) has an entry for the engine and the model.
The table is versioned, and each entry names the provider's pricing page and the date it was read. The OpenAI Decisions default model,
`gpt-6-luna`, is priced from that page: $0.10 input, $0.01 cached input and $0.50 output per million tokens, with the long-context rates
above 272,000 input tokens, read on 2026-10-13. A model with no entry is **tokens only, not priced**: its cost is null, never zero, and
the run view says so. The JEV engine reports no token usage, so its decisions write no row, and the run says its spend is not measured.

Caps count only priced cost. Unpriced spend is not counted. The priced cost is rounded up to a whole cent when it is compared with a cap,
so a cap is never under-counted. The run view states this rule.

A provider call that reports no cost writes no row, and the caps cannot see its spend. The Google image provider reports no cost today, so
a Factory run that uses it is not counted against its caps. Its reservation is still held in the budget ledger, at the per-image ceiling of
$1 (`FACTORY_IMAGE_CEILING_USD`), and settles at that ceiling. That ceiling is a guard, not a price.

The price table does not cover cache writes. The engine reports none, so a request that wrote to the prompt cache is priced only for its
input, cached input and output, and its cost can be lower than the invoice.

## Produce

Produce materializes each variant of the run for each format the run makes, through the production router
(`src/lib/meridian/factory/produce.ts`):

- **Images** are one provider call each, as before.
- **Carousels** are one carousel job with one image job for each slide. The slides come from the creative engine's carousel scope
  (`creative/engine.ts`), so the number and the words of the slides are the engine's. Each slide is produced like an image, and the
  carousel creative is made when its last slide is stored. A slide the engine left without words carries the product name alone.
- **Videos** are one provider job each, through the router's video providers (Hypit, Gemini Omni, Higgsfield, or ManualCloud). A video's
  estimate is reserved before the call. A video that finishes at once is stored and recorded. A video still at its provider keeps the run
  **running**, with its reason in the run row and `waiting_on` set to produce. The stages after produce do not run until it finishes. The
  stage checks again about every ten minutes, and the poller in the worker reads the job's own row to finish it. Nothing is marked
  produced while the job is running. A video that fails for good leaves its variant with no video, as a failed image does.
- **Caps for video.** A video's cost is a declared estimate, not a cost the provider reports, so it is not a metered row. The estimates of the
  run's own video jobs that have not failed count toward the run's total and daily caps, and a video that would pass a cap is not sent.
- A named provider that is not ready stops the run before any reservation or call, with the provider's reason (`NOT_CONFIGURED` or the
  matrix's refusal). This is the same for images, slides and videos.
- The provider is the run's choice for the format. `auto` lets the capability matrix choose. A named provider that is not configured
  or not connected stops the run, and the run row carries the provider's reason. No other provider is used in its place.
- The budget is reserved before the provider is called. A call that returns a failure releases the reservation. A call that does not
  return keeps its reservation held. A held reservation is released on its own only when the provider's own lookup confirms it holds no job for the submission. The sweep asks once the submission window has passed. No provider has such a lookup yet, so every held reservation stays for an admin, who sees the last check on the panel (see [OPERATIONS.md](OPERATIONS.md), Budgets). An admin or owner
  releases it on the Factory screen, in the Held budget panel. Other roles see the panel's rule and the reason they cannot release it.
- The image, slide and video are stored, judged and recorded by the materializer that Studio uses. The creative is in `creative_records`,
  its review is in `reviews`, and `factory_creatives` links it to its run, its variant, its format and its slide (`slide_index`, -1 for a
  creative that is not a slide). Library and Reviews read it from there. A slide is never launched on its own: the carousel is.
- A video is judged once by the same `creative_qa` check Studio runs on a video, and its judgment is metered like an image's. A video is
  never approved by the judgment alone: it stays in review, or is rejected.
- The carousel creative is not judged separately. It is judged through its slides, so the gate reads the slides' judgments.

The gate stage reads the JEV `creative_qa` record for each creative. That record holds the text questions and the visual questions
(`creative.visual_quality.v1` and `creative.product_visible.v1`). The engine answers once, when the image is judged, so the gate does
not ask again. A variant with no creative, or whose creative has no recorded decision, is review. An engine that is not configured,
or whose thresholds are not calibrated, routes to review in that record, so the gate never passes it.

## Licences

The rights gate blocks a variant until a person has recorded three things about the creatives it made (NORTH_STAR section 2, decision B).
A member attests that the brand holds the licence for the music and for the footage in each creative. A member also confirms that each
creative is labelled as AI-generated where the platform requires it. The gate reads these records. Its rules (`factory/gates.ts`) are
unchanged. Only the source of its three inputs has changed.

Each record is stored with the fixed wording shown on the run view, the person who recorded it, and the time. A revoke keeps the row with its
time, and the variant is gated again at once. Licences are attested per creative. The AI label is confirmed per variant, and the confirmation
is recorded on each creative the variant made (kind `ai_label`, migration 0075). A variant with no creative has nothing to record, so it is
blocked. A record for one brand never counts for another.

A variant passes the rights gate only when both licences and the AI label are recorded for its creatives. Until then the reason names what is
missing: a licence first, then the AI label. The table accepts a brand asset id too, but no variant references a brand asset yet, so only
creative records count.

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
probability they return goes to review, whatever the engine reports, unless the brand has a calibrated report for the question (see
[Calibration per brand and question](#calibration-per-brand-and-question)). The other three thresholds are the registry's existing values. The
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
  `provider_objects` with surface `paid` and status `paused`. In the testing runtime the fixture engine in `publishing/engine.ts` answers,
  and it takes the run's targeting countries unchanged. Outside it (`liveRouteFor` in `factory/publish.ts`), the checks run in order and
  each refusal is recorded as a failed receipt, before the publisher is called:
  - no stored Meta token: **not connected**, with the reason;
  - no targeting country on the run: refused with **no targeting country**;
  - no Facebook Page id or destination link: refused, because a Factory run carries neither yet. Without them the ad creative cannot be
    created after the campaign and ad set, which would leave paused objects behind.
  Only when all three pass does the Meta publisher run. Its ad set carries the run's countries as `targeting.geo_locations.countries`
  (`providers/meta.ts`). Nothing in the Factory sets an ad or a campaign to ACTIVE.
- **Instagram and TikTok** publish by URL, not by upload. The service signs a link to the approved creative (`storage/media-link.ts`): an
  HMAC-SHA256 over the creative id and an expiry, made with `MEDIA_LINK_SECRET`, valid for 15 minutes. The platform fetches the file through
  `/api/media-links/:creativeId`, which checks the signature and the expiry before it reads anything, and serves only an approved or testing
  creative. Instagram creates a Reels container from that link. TikTok pulls it with `PULL_FROM_URL`. Without a secret of at least 32
  characters, a public https `APP_URL`, or (for TikTok) a host listed in `TIKTOK_VERIFIED_MEDIA_DOMAINS`, the channel shows not connected
  with its reason and sends nothing. TikTok reports a post as published only with the post id it returns. An unaudited app can post only
  privately, and TikTok returns no public post id for a private post, so its receipts are unconfirmed until the app is audited.
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

## Calibration per brand and question

A grading question's threshold can be calibrated from the brand's own measured outcomes. Until it is, the question's grades go to review,
as they did before. The code is `calibration/question-method.ts` (the method and its constants), `calibration/question-outcomes.ts` (the
observations, pure), `calibration/question-store.ts` (reads, storage and the gate's lookup) and `calibration/question-recalibrate.ts` (the
recomputation).

**Observations.** A pick is one observation for each grading question its ad was answered on, when all of these hold:

- its stored `grade_fingerprint` is the ad's grade now. A pick whose ad was graded again, or that was written before migration 0071, has no
  known prediction, so it is not an observation;
- its control creative (`factory_variants.tests_attribute = 'control'`) has a measured row on the pick's surface that reports the surface's
  metric. The newest such row is the outcome. A metric the source did not report is never counted;
- the question's answer is `answered` with a probability in [0, 1]. A choice question has no probability, so it has no calibration.

A row whose metadata marks it `synthetic` or `simulated` is never a measured outcome, and never sets a baseline.

**Success.** No question in the registry defines what success is, so one rule applies to every grading question: a creative succeeds when its
metric is above the median of the brand's measured creatives on the same surface. Paid uses click-through rate (clicks divided by
impressions, both reported, impressions above zero). Organic uses completion rate. A surface with fewer than two measured creatives has no
baseline, so its picks are not observations.

**Method** (`question-calibration.v1`). Stated probabilities fall into five bins of width 0.2. A bin qualifies when it holds at least 10
observations and at least 70% of them succeeded. The threshold is the lower edge of the lowest bin from which every bin up to the top one
qualifies, so a threshold means that every stated probability at or above it has been seen to succeed at the target rate. A brand needs at
least 100 observations for a question before any threshold is set. Below that the report is uncalibrated and says "n of 100 observations
measured". A report also carries its reliability table: the count, the success rate and the mean stated probability of each bin.

**Constants, accepted for now.** The owner has accepted these constants for now: 100 minimum observations per brand and question; five bins of
0.2, with 10 observations per bin; a 70% target; and success meaning the pick beat its brand's median. They are named in
`question-method.ts` and `question-outcomes.ts`. They will be reviewed once real measured outcomes exist. Two further values the build chose
are part of the same method and are not yet set by the owner: two measured creatives for a baseline, and the paid and organic metrics the
median is taken over (click-through rate for paid, completion rate for organic). A change to any of them is a new method version.

**Storage and recomputation.** Reports are stored in `question_calibration_reports` (migration 0074). The name is not `calibration_reports`,
which migration 0045 already uses for the learned-parameter reports read by `learning/calibration-gate.ts`. A recomputation writes a report
for each question version only when its content differs from the newest one, so the newest report is the one read, and the same data stores
nothing new. Recomputation runs in the `learning.update` job after patterns are recomputed, in the Factory learn stage, and from **Recompute
from outcomes** on the Calibration screen. That button needs the admin role and writes an audit row. A failed recomputation is named in the
job's or the stage's result and does not fail the pattern update.

**Gate use.** The decision gate reads the newest report for the brand and question version whenever it decides a question. A calibrated
threshold replaces that question's approve threshold for the brand only when the calibrated value is at least the registry's approve
threshold, so calibration can only raise the bar. A calibrated value below the registry's approve threshold is not applied: the registry's
threshold stands, and the vote stays uncalibrated. Where a calibrated threshold is applied, the vote records
`calibrationStatus: "calibrated"`, the report id, its sample size and the threshold. The question's policy version is
`<question>@<version>+calibrated:<report id>`, so the decision record names the threshold it used. A question with no calibrated report, a
report that is uncalibrated or uses another method version, a report whose value is not applied, or a read that fails, keeps its registry
policy, and its threshold stays uncalibrated. The gate never reads another brand's report. Only the probability questions can be calibrated
this way. A question whose predicate is a defect (reject if true), and a question with no registry approve threshold, keeps its policy.

A calibrated threshold applies to grades decided after its report. A grade already stored under the same question versions is not asked
again, so existing grades keep the threshold they were made under.

**The Calibration screen.** Each grading question shows either its calibrated report (the threshold, the registry threshold, the reliability
table, the sample size, the report date and the method version), or "Not enough outcomes: n of 100 measured", with the number counted now. A
threshold is never shown for an uncalibrated brand. A calibrated report whose value is not applied says so, and says that the registry
threshold stands.

## Not built yet

What is left after work-queue items 10 and 11 (NORTH_STAR section 8):

- A video's cost is an estimate from the provider's declared price, not a price the provider reports, so it is not metered in
  `factory_costs`. Its estimate is held against the run's caps, but it does not appear as priced spend.
- A video or carousel that is not produced for a reason says the reason on the run, and the run stops or waits with it.
- Preflight and copy claims on the Factory image path. Factory images run no preflight and no claim check. Their specs carry no duration, and the Factory has no copy check (see [ROADMAP.md](ROADMAP.md)).
- Learning is not re-run on a schedule. The learn stage runs once in the queue, and a waiting run is checked again only with its Check learning
  button.
- Cross-surface proposals: an organic winner proposed as an ad test, or the reverse. A run with intent `both` learns each surface for its
  own arm, but no pattern on one surface is proposed as a test on the other.
- A re-grade overwrites the grade of record on `ad_timelines`. A pick made under the earlier grade can no longer show that grade, only that
  the ad was graded again. Keeping every grade needs a grade history table, which is not built.
- Organic outcomes are still one observation per post. A later organic measurement of the same post is not added to `organic_observations`.
  The paid path is per measurement (see [Learning per surface](#learning-per-surface)).
- Spend from perception reads is not metered. A perception read is a separate call from the decision, and it writes no row.
- The Factory screen was not checked in a browser from this branch. Its before and after screenshots, and the button audit, need a run of
  the app that this change did not make.
- The Factory Line editor (prompts, grading thresholds, presets) is saved for the brand, but no job reads it yet. The screen says so.
- The owner's running level and ceiling are still set in Live tests with the older levels, not with run settings.
- A live paid publish from a run is refused until the run carries a Facebook Page id and a destination link. A run has a targeting country
  now; the Page and link are the next gap.
- Uploads are not connected to Gather.
- Re-grading stored grades when a brand's calibrated report changes. A stored grade keeps the threshold it was made under until its ad is
  graded again by a new run.
- Calibration beyond the five grading questions (creative QA and the others), and a success definition per question. The one rule above
  applies to every grading question.
- Live outcomes. Organic channels return no metrics, and the test publisher has no insights source, so a brand is calibrated only from paid
  rows that a stored token has measured. The Calibration screen shows how many outcomes each brand has. Until a brand reaches the minimum,
  its grades stay uncalibrated.

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
