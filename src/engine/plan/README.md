# Visual decision engine (W7, steps 1 to 4)

Implements Video Engine Bible **section 7** (the five-step visual decision; steps 1 to 4 here, step 5 in E3), with
**6.4** (plan stage: the shot-level decision and budget fit) and **7.3** (`must` mapping). Config and weights come from
`src/engine/config/` (`weights.ts`, `budgets.ts`, `prices.ts`, `thresholds.ts`). Status and what E3 still needs: `STATUS.md`.

## Files

- `visual.ts`: `decideVisuals(input)`, the entry point. Runs steps 2, 1, 3 and 4 in that order for each shot and returns
  the shot choices, one `Decision` per shot (`by: 'scorer'`), the totals and the `unfilled` and `unsatisfiedMust` lists.
- `filter.ts`: step 1, the six hard rules (7.2), and `mustAllowedTypes` (7.3, the `must` mapping, applied as rule 1).
- `propose.ts`: step 2, the candidate pool (7.4): the example's proposals, then `may` types, then `must` types, then the
  downgrade chains (7.1).
- `score.ts`: step 3, `U(s, t)` (7.5). Every weight and the win-rate prior are read from config. Learned values that are
  missing or thin use a prior, and the result says so.
- `fit.ts`: step 4, the budget fit (7.6). Cheapest candidate per shot, then the best U-gain per cost-gain while it fits.
- `cost.ts`: the shot cost model. It mirrors `engine/budget/estimate.ts`, so the planner's totals equal the budget's.
  An unknown (null) price is never 0.
- `minimum.ts`: the format minimum (6.1 step 6, 14.2): `minimumMasterBudgetUsd(input)` returns `{ minimumUsd, lines }`. The
  fixed per-master lines plus the cheapest shot of each beat, priced with `cost.ts` and filtered with the planner's rules.
  An unknown price is refused, never 0. Used by intake (`jobs/handlers/intake.ts`); the run screen (A6) will import it.
- `tables.ts`: the plan tables (7.1, 7.3, 7.4, 7.5, 13). Data, not logic. Versioned as `planTables@1`. See `STATUS.md` for
  why they are not in `config/`.
- `types.ts`: the types the steps share. `fixtureInputs.ts`: planner inputs built from the contracts fixtures, for tests.

## Rules the code follows

- **Filter (7.2):** rule 1 `must`, rule 2 product pixels, rule 3 text in pixels, rule 4 hands on the product, rule 5
  budget (cost above the remaining room, or an unknown price), rule 6 kit missing. The first rule that removes a
  candidate is recorded in the shot's `rejected` list.
- **Remaining room:** the request budget less the fixed per-master lines (14.2, $0.52). A negative room is zero, so a
  zero-cost type always stays in the pool.
- **`must`:** each `must` keeps the types that can deliver every one of its properties. Every shot of the must's beat is
  held to that set. A must no type can deliver leaves its shot unfilled and listed in `unsatisfiedMust`. It is never
  filled with a type outside the set.
- **Downgrade chains in the pool:** a generated candidate brings its 7.1 downgrade targets (transitively) into the pool.
  This keeps a zero-cost route for every shot when the budget cannot pay for a generated type.
- **Fit:** a plan's reservation is computed as `estimatePlan` computes it (shots, fixed lines, the redo allowance on
  generated shots). An upgrade is applied only when the whole plan still fits the request budget.
- **Decisions:** every choice carries its alternatives with scores, the reason, and the priors it used.

## Tests

`NODE_ENV=development node --experimental-strip-types --test 'src/engine/plan/**/*.test.ts'`. They include the 6.4 test
(a $0.50 budget gives no generated shot), the must-honoured test, the text and hands tests, the determinism test, and a
cross-check that the planner's total equals `estimatePlan` of the plan it chose.
