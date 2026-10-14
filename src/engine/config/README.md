# Engine configuration (W1)

Implements Video Engine Bible **sections 5, 6, 7.5, 8.3, 10.2, 10.3, 10.4, 11.3, 12, 14 and 16.3**: every number the
Bible marks initial, in one versioned place. Logic elsewhere reads these; it never hard-codes them.

## Files

- `thresholds.ts` (`thresholds@1`): jobs, intake, reference, voice, plan, take and render checks, EDL rules (8.3),
  post-render checks, sampling, router concurrency and breaker (10.4), prompt challengers (11.3) and gold sets (12.4).
- `weights.ts` (`weights@1`): the visual-type score weights (7.5) and the provider score weights (10.2).
- `prices.ts` (`prices@2`): the 10.3 list prices, each `{ unit, usd, source: 'list_oct_2026' }`, and the default route
  for each model class (the first provider in 10.3 priority order). `tokenRates` (contract v2) holds the Claude token
  rates of 11.1 in USD per million tokens, keyed by the OpenRouter model id in `routes.ts`. Haiku is at Haiku 4.5's
  $1 / $5 until Haiku 5.5's rate is confirmed (an owner check). `claude/rates.ts` still holds its own copy until the lead
  points it at `prices.tokenRates`. The config tests check that the token-rate keys are exactly the Claude models the
  route table names.
- `budgets.ts` (`budgets@1`): the redo allowance (14.1), the fixed per-master cost (14.2), variant costs (14.3), the
  overrun alert share (14.4) and the production mode (`cap`). There is no default budget by format: the user sets it.
- `tunable.ts`: `Tunable { value, floor, ceiling }`, `tunable(...)` (refuses a value outside its bounds) and
  `clampTunable(next, current, maxChangeShare = 0.15)` (section 16.3).

## Rules

- Tuned values (16.2) are `Tunable`. Their floors and ceilings are proposals from eng-contracts; the lead confirms them.
  Constants (hard rules and structural numbers) are plain values.
- A price is `null` when the Bible gives it as token-priced, per model, "verify", or leaves the vendor open. A null
  price is never read as 0 or guessed. The estimate refuses a shot whose price is null.
- The platform file-size limit is not in the Bible, so `render.platformMaxBytes` is `null`. The integrity gate must
  not pass on size until the owner sets it.
- The take gate (12.2) is `thresholds.take`. Its values are the Bible's: duration within 10 per cent, no black or frozen
  run over 2 frames, flicker below 0.25, motion above 0.05, product match 0.85, persona match 0.80, palette 0.70, no
  generated words, rubric items 0.7, and escalation below critic confidence 0.6. The floors and ceilings of those tunables
  are E1 proposals, not Bible numbers (see `contracts/STATUS.md`).
- Each file carries its version string. A configuration change bumps it, and the manifest records the version used
  (16.3). Manifest does not yet have a field for it; see `contracts/STATUS.md`.
