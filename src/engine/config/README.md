# Engine configuration (W1)

Implements Video Engine Bible **sections 5, 6, 7.5, 8.3, 10.2, 10.3, 10.4, 11.3, 12, 14 and 16.3**: every number the
Bible marks initial, in one versioned place. Logic elsewhere reads these; it never hard-codes them.

## Files

- `thresholds.ts` (`thresholds@3`): jobs and leases, intake, reference, voice, plan, take and render checks, EDL rules (8.3),
  the editor's build steps (`editor`, 8.2), post-render checks, slideshow risk (`slideshow`, 12.3), sampling, router concurrency
  and breaker (10.4), prompt challengers (11.3) and gold sets (12.4).
  `thresholds@2` added `router.breaker.minSample` and `router.minAttempts`, both initial values the Bible does not give.
  `thresholds@3` adds `jobs.leaseMs.plan` (three Claude leases, 6 minutes, because the plan job runs three Claude calls under
  one lease), the `editor` block moved from `edit/tuning.ts`, and the `slideshow` block moved from `review/tuning.ts`. A value
  the Bible gives is plain (for example `editor.cutSnap.gapMinMs` 80, Bible 8.2 step 3, or `slideshow.codedRunMax` 4, from the
  19 E4 acceptance). A value it does not give is a Tunable with bounds, a proposal the lead confirms. The lists in `slideshow`
  are documented initial data; `config.test.ts` checks their members against the contract enums.
- `weights.ts` (`weights@1`): the visual-type score weights (7.5) and the provider score weights (10.2).
- `prices.ts` (`prices@2`): the 10.3 list prices, each `{ unit, usd, source: 'list_oct_2026' }`, and the default route
  for each model class (the first provider in 10.3 priority order). `tokenRates` (contract v2) holds the Claude token
  rates of 11.1 in USD per million tokens, keyed by the OpenRouter model id in `routes.ts`. Haiku is at Haiku 4.5's
  $1 / $5 until Haiku 5.5's rate is confirmed (an owner check). `claude/rates.ts` still holds its own copy until the lead
  points it at `prices.tokenRates`. The config tests check that the token-rate keys are exactly the Claude models the
  route table names.
- `model-preferences.ts` (`model-preferences@1`, contract v7): the ranked OpenRouter model ids per production class (Bible 10.5
  step 4). Every list starts empty by owner decision (2026-10-16); they are filled later from the gold sets. Lip-sync has no row.
- `budgets.ts` (`budgets@1`): the redo allowance (14.1), the fixed per-master cost (14.2), variant costs (14.3), the
  overrun alert share (14.4) and the production mode (`cap`). There is no default budget by format: the user sets it.
- `adapters.ts` (`adapters@1`): the provider adapter and router settings that the assets code held as constants: polling and
  retry timing (5 s, 1 s base, 30 s cap), HTTP timeouts per provider, output byte and URL limits (`normalise.ts`), and stock
  page sizes, and the model catalog's cache lifetime (`catalog.ttlMs`, initial 10 min, Bible 10.5 step 1). It also holds the
  1080 x 1920 output (Bible 1) and the 7-day reliability window (10.2). The Bible gives none of
  the timing, limit or page-size numbers, so each is a Tunable with bounds (a proposal).
- `tunable.ts`: `Tunable { value, floor, ceiling }`, `tunable(...)` (refuses a value outside its bounds) and
  `clampTunable(next, current, maxChangeShare = 0.15)` (section 16.3).

## Rules

- Tuned values (16.2) are `Tunable`. Their floors and ceilings are proposals from eng-contracts; the lead confirms them.
  Constants (hard rules and structural numbers) are plain values.
- A value the Bible does not give is an initial value marked `Tunable` with bounds, or `null` where no sensible value exists
  (E3 rule). `Tunable` on such a value means "documented initial value with bounds". It does not mean the nightly loop moves
  it. Section 16.2 names what the loop tunes.
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
