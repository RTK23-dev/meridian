# STATUS: engine contracts (W1, with config)

## Phase E3: contract version `engine-contracts@3` (current)

Branch `eng-e3-contracts`, based on `origin/code/beautiful-cori-1zfk11` at aa3bcf8. Not pushed; for the lead to review and merge.
Covers `src/engine/contracts/`, `src/engine/config/`, and the budget pre-flight hold (`src/engine/budget/`, see its STATUS). Bible
section 4 has the migration note ("v3 changes and migration").

### Changes (the lead's five items)

1. **Pre-flight hold (budget, `preflight.ts`).** `reserveFixed` and `extendReservation`. Not a contract change. The decisions
   and the four open points are in `budget/STATUS.md`.
2. **Manifest roleCalls (`manifest.ts`), `meridian.manifest/v2`.** Adds the optional `roleCalls` array of `ManifestRoleCall`: `role`,
   `promptVersion`, `model`, `answeredBy`, `generationId`, `tokens` (`{ prompt, completion }`, each null when unknown), `costUsd`
   (null when unknown), `actualIsEstimate`, `verdict` (`answered` or `invalid_answer`). The fields are the lead's list. The journal
   (`claude/journal.ts` `RoleCall`) also has `idempotencyKey`, `ledgerEntryId` and `issues`, which the lead's list leaves out. See
   "Decisions" below.
   - Invariants the schema enforces: `promptVersion` is a version of `role`; each role call's version is the one `promptVersions`
     records for that role; a null cost, and an invalid answer, carry `actualIsEstimate: true`.
   - The literal moves to `/v2` (the lead asked for a version bump on this type). Nothing stored yet: `engine_manifests` has no
     writer. A v2 manifest without `roleCalls` is valid.
3. **Config move (`config/adapters.ts`, `adapters@1`, and `thresholds@2`).** The assets constants, with the values assets/STATUS.md
   recorded. Values the Bible gives are plain; the rest are Tunable with bounds (the bounds are proposals).
   - `adapters.polling.intervalMs` 5 s (1 to 30 s); `adapters.retry.backoffBaseMs` 1 s (0.25 to 10 s); `adapters.retry.backoffCapMs`
     30 s (5 to 120 s).
   - `adapters.reliabilityWindowMs` 7 days (Bible 10.2, plain).
   - `adapters.timeoutsMs`: video submit 60 s, image 120 s, speech 120 s, Pexels 30 s, Pixabay 30 s.
   - `adapters.outputLimits`: image 1 KiB to 32 MiB, speech 1 KiB to 64 MiB, URL 2048 characters.
   - `adapters.stock`: Pexels page size 15 (1 to 80, the ceiling a proposal), Pixabay 20 (3 to 200, documented).
   - `adapters.output`: 1080 x 1920 (Bible 1, plain). Stock minimums are derived from it.
   - `thresholds.router.breaker.minSample` 5 (1 to 50): the breaker trips only after this many provider-side attempts. The Bible
     gives no minimum; without one, one failure in an empty window trips it (assets decision 4).
   - `thresholds.router.minAttempts` 10 (1 to 100): unknown-score policy. Below this many attempts, a provider's reliability is
     unknown and left out of its score. The Bible gives no number, and the "too few attempts" rule is in score.ts's comment only.
     The assets code does not read it yet.
4. **Config tests.** `config.test.ts` checks the version strings, the 51 Tunables (thresholds 19, weights 16, budgets 1, adapters 15),
   every moved value, and that the integer values are integers.
5. **Version:** `CONTRACTS_VERSION = "engine-contracts@3"`. Bible section 4 v3 note added.

### Lead actions: one-line changes in `src/engine/assets` (not made here; eng-media-assets' folder)

Each is a change to the assets code. Imports from `../config/adapters.ts` and `../config/thresholds.ts` are needed in each file.

- `assets/router.ts`: `ROUTER_CONSTANTS` becomes `adapters` values. `pollIntervalMs: adapters.polling.intervalMs.value`,
  `backoffBaseMs: adapters.retry.backoffBaseMs.value`, `backoffCapMs: adapters.retry.backoffCapMs.value`,
  `reliabilityWindowMs: adapters.reliabilityWindowMs`. Keep the export name or update the importers.
- `assets/router.ts` and `assets/breaker.ts`: add `minSample: thresholds.router.breaker.minSample.value` to `defaultRouterSettings`
  and to `BreakerSettings`. In `evaluateBreaker`, return null when `window.length < settings.minSample`. This is a logic change, not
  one line. The breaker.ts open question is then closed.
- `assets/providers/openrouterVideo.ts`: `VIDEO_SUBMIT_TIMEOUT_MS` becomes `adapters.timeoutsMs.videoSubmit.value`.
- `assets/providers/openrouterImage.ts`: `IMAGE_TIMEOUT_MS` becomes `adapters.timeoutsMs.image.value`.
- `assets/providers/openrouterSpeech.ts`: `SPEECH_TIMEOUT_MS` becomes `adapters.timeoutsMs.speech.value`.
- `assets/providers/pexels.ts`: `PEXELS_TIMEOUT_MS` becomes `adapters.timeoutsMs.pexels.value`; `PER_PAGE` becomes
  `adapters.stock.pexels.perPage.value`; `MIN_FILE_HEIGHT` becomes `adapters.output.width` (1080; it is the portrait short side as the
  code uses it); `OUTPUT_HEIGHT` becomes `adapters.output.height`.
- `assets/providers/pixabay.ts`: `PIXABAY_TIMEOUT_MS` becomes `adapters.timeoutsMs.pixabay.value`; `PER_PAGE` becomes
  `adapters.stock.pixabay.perPage.value`; `MIN_WIDTH` and `MIN_HEIGHT` become `adapters.output.width` and `adapters.output.height`.
- `assets/normalise.ts`: `OUTPUT_LIMITS` becomes `{ imageMinBytes: adapters.outputLimits.imageMinBytes.value, ... }` (five values).
- Scoring: the router's unknown-score policy has no minimum in code. Wire `thresholds.router.minAttempts` into `score.ts` or leave it
  as a documented gap (lead decision).

### Decisions (lead to confirm)

- **`manifest` literal to `/v2`.** The additive changes in E2 kept their `/v1` literals. The manifest literal moves because the lead
  asked for a version bump on this type. Say if you want the additive form kept at `/v1` (the set version would still bump).
- **The journal's extra fields are not on the manifest.** `idempotencyKey` and `ledgerEntryId` would let an auditor join a role call
  to its ledger row. `issues` holds check paths and codes. None is in the lead's list, so none is added. Say if you want them.
- **`configVersion` is still owed (Bible 16.3).** The manifest needs it before the E5 writer. It is not in this bump because the
  lead's brief did not include it. The next manifest change is `/v3`, or it goes in now as an optional field.
- **Tunable bounds are proposals.** Each floor and ceiling is a proposal. `Tunable` marks an initial value the Bible does not give. It
  does not mean the nightly loop moves it: 16.2 names what the loop tunes.

### Not moved (still outside config; the lead to schedule)

PHASE_LOG (wave B) assigns these to eng-contracts for E3. The brief for this change did not include them, so they are not moved here:

- `plan/tables.ts`: the 7.3 and 7.4 tables and some initial values.
- `media/config.ts`: the scene score and timeouts.
- `jobs/settings.ts`: the priority numbers (rush 10, normal 100, batch 1000), the poll backoff and the analysis retry count.

### Tests (run in this worktree, E3)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/contracts/**/*.test.ts' 'src/engine/config/**/*.test.ts' 'src/engine/budget/**/*.test.ts'`:
  `# tests 274`, `# pass 274`, `# fail 0`, `# skipped 0` (final run on this commit).
- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/**/*.test.ts'`: `# tests 1144`, `# pass 1144`, `# fail 0`,
  `# skipped 0` (final run on this commit).
- `node --test scripts/engine/*.test.mjs`: 7 pass, 0 fail.
- `npm run typecheck`: exit 0. `npm run lint`: exit 0, 0 errors, 4 warnings, all in `src/components/` (pre-existing).
- The full `npm test` was not run here; the lead runs it after merging.

### Live run: owner

No live call was made, and nothing in E3 needs a key. No migration was written: `roleCalls` lives in the manifest JSON, and no
manifest writer exists yet (E5). When eng-pipeline puts the pre-flight hold on the Postgres ledger store, the owner runs
`reserveFixed` and `extendReservation` against real PostgreSQL (see `budget/README.md`).

---

## Phase E2: contract version `engine-contracts@2`

Branch `eng-e2-contracts`, based on `origin/code/beautiful-cori-1zfk11` at a4b04c7. Not pushed. Covers `src/engine/contracts/`
and `src/engine/config/`, and the budget code that writes `LedgerEntry` (`src/engine/budget/`, see its STATUS). Bible section 4
has the migration note ("v2 changes and migration").

### Changes (the lead's five items)

1. **Claude token rates moved to `config/prices.ts`.** `prices.tokenRates` is keyed by the OpenRouter ids in `config/routes.ts`:
   Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10 (Bible 11.1), Haiku 5.5 $1 / $5 (Haiku 4.5's rate until confirmed). Each entry is
   exactly `{ inputUsdPerMillion, outputUsdPerMillion }`, the shape `claude/rates.ts` uses, so its test still passes after the
   re-point. `prices` is now `prices@2`. `ClaudeModelId` and `TokenRate` are exported.
2. **`VoiceKit.wordsPerMinute`** is optional, positive and finite. Intake can use it for a page with no persona (Bible 6.1
   step 4). The fixture voice kit has 150.
3. **`LedgerEntry.role` and `LedgerEntry.promptVersion`** are optional and set together. `role` is an enum of the ten Bible 11.1
   roles (`CLAUDE_ROLES`). `promptVersion` is `<role>@<n>` (for example `planner@1`), and it must be a version of `role`. Rows
   from v1 have neither and stay valid. New fixture `ledgerEntryClaude` (planner, Opus 5.5, estimate $0.16, actual $0.142).
   `budget/reserve.ts` `authorizeCall` takes both fields and refuses one without the other.
4. **`thresholds.take` needed no change.** At `thresholds@1` it already held the Bible 12.2 numbers: duration within 10 per
   cent, black or frozen run at most 2 frames, flicker below 0.25, motion above 0.05, product 0.85, persona 0.80, palette 0.70,
   generated words 0, rubric items 0.7, 6 rubric frames, escalation below critic confidence 0.6. The version stays `thresholds@1`.
   `config.test.ts` now pins these numbers. `thresholds.render.platformMaxBytes` stays `null` with its comment.
5. **Version:** `CONTRACTS_VERSION = "engine-contracts@2"` (`version.ts`, exported from `index.ts`). Types with a `schema`
   literal keep their `/v1` literals, since none of them changed. `LedgerEntry` and `VoiceKit` have no literal, so the set
   version carries their bump.

### Tests (run in this worktree, E2)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/contracts/**/*.test.ts'`: 139 pass, 0 fail.
- `... 'src/engine/config/**/*.test.ts'`: 27 pass, 0 fail.
- `... 'src/engine/budget/**/*.test.ts'`: 56 pass, 0 fail.
- `... src/engine/claude/rates.test.ts`: 3 pass, 0 fail (the local table; not re-pointed, see below).
- All engine tests, `'src/engine/**/*.test.ts'`: 849 pass, 0 fail, 0 skipped.
- `node --test scripts/engine/e1-acceptance.test.mjs` (dry run and fail-closed checks): 7 pass, 0 fail.
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0, 0 errors, 4 warnings, none in `src/engine` (all in `src/components/`).
- The full `npm test` was not run here; the lead runs it after merging.
- Scratch check (outside the repo): the proposed re-point of `claude/rates.ts` to `prices.tokenRates` type-checks under
  `--strict`.

### Lead actions

- **`src/engine/claude/rates.ts` (one change, not made here):** add `import { prices } from "../config/prices.ts";` and replace
  the `claudeRates` literal with `export const claudeRates: Readonly<Record<string, TokenRate>> = prices.tokenRates;`. Then run
  `rates.test.ts`. It was not run with the re-point applied.
- **Intake and the Claude client (eng-pipeline, W3):** the intake handler takes the speech rate from the persona only. It should
  fall back to `voice.wordsPerMinute` when the persona is absent (the rate is in the contract now). The Claude client should pass
  `role` and `promptVersion` into `paidCall` and `authorizeCall`. `gateway/paid.ts` `PaidCallInput` has no such fields yet.
- **`engine_ledger` (eng-pipeline):** nullable `role` and `prompt_version` columns, no backfill (the migration note in Bible
  section 4 says so).
- **Bible skill copy:** `.claude/skills/engine-bible/SKILL.md` copies section 4 verbatim and does not have the v2 note. The file
  wins, so the skill needs regenerating. That is shared scope, so the lead decides.

### Decisions to confirm (lead)

- `LedgerEntry` and `VoiceKit` have no `schema` literal, so the contract-set version carries the bump. Adding literals would
  break rows already stored without them. Say if you want literals anyway.
- `ClaudeRole` is a closed enum of the ten Bible 11.1 roles. A new role is a contract change.
- The Haiku rate is a placeholder until the owner confirms it.

### Live run: owner (no keys held by agents)

No live API was called. The owner's checks for this change:

1. Confirm the Haiku 5.5 rate and the Opus 5.5 and Sonnet 5.5 rates with billed calls. Compare the token counts and costs of 10
   Claude calls on OpenRouter with `prices.tokenRates`, and set the rates that differ.
2. Once `claude/rates.ts` is re-pointed, run one live `planner` call and check its `LedgerEntry` carries `role` and
   `promptVersion` in Postgres.

These are unchanged from E1: the render price (`render_hyperframes_cloud` is `null`), the speech-to-text vendor and its price,
`thresholds.render.platformMaxBytes`, and the price table replaced by reconciled actuals after 50 calls.

### Open points found (not resolved in code)

- **Tunable bounds are proposals.** Bible 16.3 requires a floor, a ceiling and a nightly change limit for every tuned value. The
  Bible gives none of the floors or ceilings, so those in `thresholds.ts`, `weights.ts` and `budgets.ts` are E1 proposals. If the
  lead wants them null, `tunable` and `clampTunable` need a change first.
- Bible 8.3 says true peak "≤ −1 dBTP" in one place, and 8.2 and 12.3 say −1 dBTP. The code uses −1. The Bible text needs fixing.
- Bible 16.3 requires the manifest to record the configuration version. `Manifest` has no field for it, and section 4 field names
  are fixed. This needs a version change of its own.
- Bible 13 allows `captionStyle.component: 'captions.minimal'`, which is not in the 9.2 library.
- Bible 8.2 numbers (snap windows, ducking, attack and release) are not in config. They are not marked initial, so W8 decides.
- The Bible 16.2 price table is tuned, but `{ unit, usd, source }` has no floor or ceiling. Not added.
- Cached-input reads ($0.20 per million) and Batch pricing (half price) are in the Bible's rates but not modelled, because the route
  cannot use them yet (Bible 20.3 item 6).

### Blockers

None for fixtures and tests. The live items above need the owner.

---

## Phase E1 (wave A): historical record

The E1 work covered every section 4 contract as zod, the v1 additions, section 13 kits, the section 10.1 adapter types, ids,
canonical JSON and `contentHash`, money, `EngineError`, one consistent fixture chain, one fixture per kit, and config at
`thresholds@1`, `weights@1`, `prices@1`, `budgets@1` with `clampTunable`.

Decisions made in E1 (still in force unless listed above):

- A `GateResult` or `TakeVerdict` passes only with at least one check and every check passing.
- A `BudgetReservation.reservedUsd` is the live hold. A paused one holds nothing; a released one shrinks to the committed amount.
  `estimateUsd` must equal the sum of the lines.
- `Composition.contentHash` is `contentHash(files)`, and it is the render idempotency key.
- Id prefixes: `req_ dna_ shot_ take_ edl_ vid_` and the v1 additions `art_ asp_ res_ cmp_ led_`. Other ids are non-empty strings.
- `usdSchema` requires at most 4 decimals.
- `ArtifactEnvelope.type` includes `take_verdict`, which has no `schema` literal in the Bible.
- Extra helper files beyond the brief: `contracts/primitives.ts` and `config/tunable.ts`.

Open points from E1 that remain: the Bible 8.3 true-peak text, the 16.3 manifest config version, the tunable bounds, the
`captions.minimal` component, and the section 8.2 numbers (all listed above).
