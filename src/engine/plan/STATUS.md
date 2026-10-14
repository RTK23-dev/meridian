# STATUS: visual decision engine (W7, steps 1 to 4)

Phase E1, wave B. Branch `engine/e1-w7-w11`, cut from `code/beautiful-cori-1zfk11` (which contains wave A). Covers
`src/engine/plan/`. Steps 1 to 4 are pure code and fixture-tested. No Claude call was made (the client is not built).

## Done

- `decideVisuals(input)` in `visual.ts`: steps 2, 1, 3 and 4 for every shot. It returns the shot choices, one scorer
  `Decision` per shot (alternatives with scores, labelled priors, reason), the totals, and the `unfilled` and
  `unsatisfiedMust` lists.
- Step 1 (`filter.ts`): the six rules of 7.2, with the 7.3 `must` mapping as rule 1 (`mustAllowedTypes`).
- Step 2 (`propose.ts`): the 7.4 table, `may` types, `must` types, and downgrade chains (7.1).
- Step 3 (`score.ts`): U(s, t) from 7.5. Each weight, the win-rate prior and the sample minimum are read from
  `config/weights.ts`. Missing or thin learned values use a prior, and each prior is named in the alternative's label.
- Step 4 (`fit.ts`): the cheapest candidate per shot, then the best U-gain per cost-gain while the plan fits the request
  budget. Unknown prices are excluded, never priced at 0.
- `cost.ts`: the shot cost model, with the same billing rule and rounding as `engine/budget/estimate.ts`.
- `tables.ts` (`planTables@1`): the property, proposal, recipe, downgrade, beat-fit, family, kit and risk-prior tables.

## Tests (run in this worktree)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/plan/**/*.test.ts'`: 59 pass, 0 fail.
- The required cases are there: the 6.4 test (a $0.50 budget gives no generated shot; the fixture plan has stock and
  coded shots only); a must is always honoured across budgets and kit sets; text-in-pixels and hands-on-product shots
  never get a generated type; the same inputs give the same plan.
- Two cross-checks against the contracts. At $4 the planner reproduces the fixture plan's shot types, its $0.3516 shot
  total and its $0.9595 reservation. At budgets $4 and $1 the planner's reserved total equals `estimatePlan` of the plan it
  chose. Other budgets are not cross-checked.
- The cost of every priced type equals the budget module's line for the same shot.
- `npm run typecheck`: exit 0. `npm run lint`: 0 errors (4 pre-existing warnings in `src/components/`, not touched).

## Live run: owner (no keys held by agents)

Nothing here calls a provider, so no live run is needed for steps 1 to 4. The owner-only items are these:

1. Confirm the price of `image.edit` (`nano_banana_2` is token-priced, so `stop_motion` is never chosen). Until it is priced,
   `stop_motion` is always excluded, and that is correct.
2. Confirm the visual-type weights and the beat-fit table once there are real take outcomes (7.5, 16.2).

## For E3 (not built here)

- **Step 5, the director check** (7.7): one Opus call with the plan table, the genome and the persona. Its swaps must stay
  inside each shot's filtered candidates and the budget. Expose `decideVisuals`'s `shots` and `fitsBudget` for it.
- **The 7.3 classifier** (Haiku, structured output): it produces `ClassifiedRequest.properties` for every visual request.
  The planner takes the classification as input, so it cannot be built before the Claude client exists.
- **Alignment and shot splitting** (6.4 steps 1 and 2): `align.ts` is not written. The planner takes `refShot`, the beat
  role, the duration and the flags for each shot. E3 must produce them.
- **Source building** (6.4 steps 4 and 5): prompts (Opus, with the style kit and character sheets), component props (with
  a product URI for every product beat), stock queries and asset URIs. The planner returns the type and `downgradeTo`
  only. `RECIPES` gives the model class and takes for each generated type.
- **Flags** (7.2 rules 2 to 4): `textInPixels`, `handsOnProduct` and `showsProduct` are inputs. Only the director or the
  classifier can set them.

## Open points for the lead

1. **Placement of the plan tables.** The brief says every number comes from `src/engine/config/`, but `config/` belongs
   to W1, and this worktree may not write there. The tables are in `plan/tables.ts`: the property map, the proposals, the
   beat-fit values (7.5), the style-fit values (1, 0.5, 0), the artifact-risk priors, the kit requirements and the
   recipes. The beat-fit values, the style-fit values and the artifact-risk priors are my judgement; the Bible gives no
   numbers for them. The lead decides whether they move into `config/` (one file, versioned) and who confirms the values.
2. **A $0.50 request budget cannot deliver.** 14.2 puts the fixed per-master lines at $0.52. So at $0.50 the plan's
   reservation is $0.52, over budget. The planner gives the all-code plan the 6.4 test asks for, and `fitsBudget` is false.
   The plan gate then refuses it. Either the minimum request budget is above $0.52, or the fixed lines are excluded from
   the request budget. This is an owner decision.
3. **Banned style types are a score term, not a filter.** The Bible lists banned types under styleFit (7.5), not in the
   six rules. A banned type can still be chosen when it is the only candidate that survives. Making it a seventh filter
   rule is the lead's call.
4. **Downgrade chains are candidates.** 7.4 does not list downgrades as candidates. I added them, so that a zero-cost
   route always exists for each shot (without them a $0.50 budget leaves talking-head shots with nothing). This changes
   what the planner can choose: check that you want it.
5. **Keyframe not priced.** `cartoon_generated` needs an `image.keyframe` plus image-to-video. The budget contract
   (`ShotSource`) carries one `modelClass`, so the planner and `estimatePlan` both price only the video model. The
   keyframe is under-counted. This is a contract gap for W1 or E3.
6. **Stop-motion billing.** The planner bills 12 frames per second (7.1, top of the range). `estimatePlan` bills one call
   per shot for `per_image`. The two would differ if `image.edit` is ever priced per image. It is excluded until then.
7. **Real-person consent (13) cannot be checked.** `Persona` has no field for "based on a real person", and `VoiceKit` has
   no real-person flag at all. The request gate checks the kits exist and their versions match, but not consent. A
   contract field is needed.
8. **Kit needs (7.2 rule 6).** The Bible says a persona or a character. I also treat the product kit as needed by
   `product_hero` and `stop_motion`, because both pin the hero image. This is an extension of rule 6, and it is flagged.
9. **Learned artifact risk uses the win-rate sample minimum.** 7.5 gives the sample minimum for win rate only. I use the
   same minimum (`weights.winRateMinSamples`, 30) for take failure rates. A separate config value would be cleaner.
10. **Interpretations to confirm.** (a) A `must` binds every shot of its beat, not just one. (b) A stock shot counts as
    zero-cost, so the 6.4 "all-code" test allows stock as well as components. (c) A beat is a product beat if any of its
    requests (must or may) is classified `real_product`, or the caller marks it. (d) The greedy fit scores each upgrade
    with the choices made before that shot. An upgrade's effect on the next shot's continuity is not re-scored.
    (e) Decisions use the shot id as `at`. The fixture's first decision uses the beat id, so `at` is not uniform there.

## Blockers

None for the fixture work. Items 2 and 7 above need an owner or contracts decision before a live run can deliver a
$0.50 master or a persona with a consent check.
