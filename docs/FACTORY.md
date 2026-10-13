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

## Spend caps: a caveat

`full` runs only while a cap is set, and it stops when metered spend reaches that cap. Metered spend is the rows in `factory_costs`.
No stage writes a metered cost yet. The fixed estimates that used to fill that table were removed, because they were not measured.
So in this release a `full` run with a cap set runs until the caps are reached in the ledger, and the ledger records no spend from the
Factory stages. Treat the cap as declared, not enforced, until the produce stage routes its provider calls through the budget ledger.

## What grading uses

The grade stage scores each ad from what the source reported. The Meta Ad Library collector requests the ad's stop time and the countries
it reached, and stores them with the ad. An ad whose stop time is absent is still delivering as of capture. An ad collected before this
release has no stop time stored, so its delivery is unknown.

- Unknown delivery, track record and quality contribute nothing to the score. The range widens and the evidence names what is missing.
- Days running run from the first sighting to the last. An ad is not counted as running up to today.
- The advertiser's track record is the share of its ads, among those with a known delivery, that are still delivering.

The JEV grade is not implemented. It needs the owner's choice of grading questions and thresholds, which NORTH_STAR section 9 lists as an
open question. Until then every grade is the observed signal only.

## When a run finishes

A run is finished only when the learn stage does its real work. Learning is not built yet, so a run that reaches the end of the
graph stays `running`, and the run row says `learn:not-built`. No other stage marks a run finished. Review counts the variants that
wait for a person and leaves the run where the stop points put it. A run that waits at a stop is `awaiting_approval`, and a run the
kill switch stops is `paused`.

## Not built yet

Work-queue items 3, 5, 6, 8, 9, 10 and 11 of NORTH_STAR section 8 are open. In short: Gather does not yet call the sourcing stack for each
source; Pick and Plan do not use grades and Thompson allocation, and variants still come from a fixed hook and CTA list; produce does not
materialize through the production router into the Studio creative tables; publish and measure both paths are not built; learning is not
per surface; and the Factory screen does not show the run settings or the approve action. See [ROADMAP.md](ROADMAP.md).
