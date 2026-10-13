# Engine configuration (W1)

Implements Video Engine Bible **sections 5, 6, 7.5, 8.3, 10.2, 10.3, 10.4, 11.3, 12, 14 and 16.3**: every number the
Bible marks initial, in one versioned place. Logic elsewhere reads these; it never hard-codes them.

## Files

- `thresholds.ts` (`thresholds@1`): jobs, intake, reference, voice, plan, take and render checks, EDL rules (8.3),
  post-render checks, sampling, router concurrency and breaker (10.4), prompt challengers (11.3) and gold sets (12.4).
- `weights.ts` (`weights@1`): the visual-type score weights (7.5) and the provider score weights (10.2).
- `prices.ts` (`prices@1`): the 10.3 list prices, each `{ unit, usd, source: 'list_oct_2026' }`, and the default route
  for each model class (the first provider in 10.3 priority order).
- `budgets.ts` (`budgets@1`): the redo allowance (14.1), the fixed per-master cost (14.2), request defaults and variant
  costs (14.3, 14.4), and the production mode (`cap`).
- `tunable.ts`: `Tunable { value, floor, ceiling }`, `tunable(...)` (refuses a value outside its bounds) and
  `clampTunable(next, current, maxChangeShare = 0.15)` (section 16.3).

## Rules

- Tuned values (16.2) are `Tunable`. Their floors and ceilings are proposals from eng-contracts; the lead confirms them.
  Constants (hard rules and structural numbers) are plain values.
- A price is `null` when the Bible gives it as token-priced, per model, "verify", or leaves the vendor open. A null
  price is never read as 0 or guessed. The estimate refuses a shot whose price is null.
- The platform file-size limit is not in the Bible, so `render.platformMaxBytes` is `null`. The integrity gate must
  not pass on size until the owner sets it.
- Each file carries its version string. A configuration change bumps it, and the manifest records the version used
  (16.3). Manifest does not yet have a field for it; see `contracts/STATUS.md`.
