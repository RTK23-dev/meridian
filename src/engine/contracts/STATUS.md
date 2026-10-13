# STATUS: engine contracts (W1, with config)

Phase E1, wave A. Branch `engine/e1-w1-w12`, based on e0245c9. Covers `src/engine/contracts/` and `src/engine/config/`.

Base note: the worktree branch `worktree-agent-a86e50bac556237f8` was at d0e8f63, which is not e0245c9 and does not
contain the engine briefing or the Bible. Work went on a new branch from e0245c9. The old branch was not changed.

## Done

- Every section 4 contract as zod v4 (4.1 to 4.4): exact field names, schema literals, `z.infer` types.
- The lead's v1 additions: `ArtifactEnvelope`, `AssetSpec` with `assetCacheKey`, `ValidatedRequest`, `IntakeRejection`,
  `BudgetReservation`, `Composition`, `ReviewResult`, `LedgerEntry.actualIsEstimate`. Listed in Bible section 4.
- Section 13 kits and section 10.1 `ProviderAdapter` / `ProviderError`.
- Ids (prefixed ULID, time-ordered, monotonic within a process), canonical JSON, `contentHash`, money, `EngineError`.
- One consistent fixture chain (request to manifest, plus reservation and ledger) and one fixture per kit, exported
  from `fixtures/index.ts`.
- Config: `thresholds@1`, `weights@1`, `prices@1`, `budgets@1`, and `clampTunable` (16.3).

## Tests (run in this worktree)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/contracts/**/*.test.ts'`: 125 pass, 0 fail.
- `... 'src/engine/config/**/*.test.ts'`: 18 pass, 0 fail.
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0. No findings in `src/engine`. Six warnings remain in files outside it (`src/components/`),
  which were already there and are untouched.
- The full `npm test` was not run here; the lead runs it after merging.

## Live run: owner (no keys held by agents)

No live API was called. Items the owner must confirm or run:

1. Read the bills for 10 test renders. Set `render_hyperframes_cloud` to a verified price (Bible 10.3 says "verify";
   it is `null` now).
2. Confirm the Haiku 5.5 rate (Bible 11.1 uses Haiku 4.5's rate until then). Not in `prices.ts`, which is `null` for
   token prices.
3. Choose the speech-to-text vendor (Bible 20.2) and set its price.
4. Set `thresholds.render.platformMaxBytes`. It is `null`, so the integrity gate cannot pass on size until then.
5. Confirm the price table is replaced by reconciled actuals after 50 calls (Bible 10.3). Not built here; it needs the
   ledger table (W2/W12 store).

## Decisions made here (lead to confirm)

- A `GateResult` or `TakeVerdict` passes only with at least one check and every check passing.
- A `BudgetReservation.reservedUsd` is the live hold. A paused one holds nothing; a released one shrinks to the
  committed amount. `estimateUsd` must equal the sum of the lines.
- `Composition.contentHash` is `contentHash(files)`, and it is the render idempotency key.
- Id prefixes: only the ones named (`req_ dna_ shot_ take_ edl_ vid_`) plus the v1 additions (`art_ asp_ res_ cmp_
  led_`). `voiceTrackId`, `planId`, `segId`, `wordId`, `beatId`, `clipId` and kit ids are plain non-empty strings.
- `usdSchema` also requires at most 4 decimals (Bible section 4 convention).
- `ArtifactEnvelope.type` enumerates the artifact types, including `take_verdict`, which has no `schema` literal in
  the Bible.
- Tuned values (`Tunable`) have floor and ceiling bounds proposed here. The lead confirms them.
- Extra helper files beyond the brief: `contracts/primitives.ts` (time and check helpers) and `config/tunable.ts`
  (`Tunable`, `tunable`, `clampTunable`).

## Open points found in the Bible (not resolved in code)

- Section 8.3 says true peak "<= 1 dBTP". Sections 8.2 and 12.3 say -1 dBTP. The code uses -1
  (`thresholds.postRender.truePeakMaxDbtp`). The owner should fix the 8.3 text.
- Section 16.3 requires the manifest to record the configuration version used. The section 4 `Manifest` has no field
  for it, and field names are kept exactly as section 4. Needs a v1 addition or a version bump.
- Section 16.3 requires floors and ceilings on every tuned value. The price table is tuned (16.2), but its shape
  `{ unit, usd, source }` has none. Not added.
- Section 13 allows `captionStyle.component: 'captions.minimal'`, which is not in the section 9.2 component library.
- Claude token rates (11.1) are not in `prices.ts` because they are token-priced. The per-master Claude cost (14.2,
  $0.40) is in `budgets.ts`.
- Section 8.2 numbers (snap windows, ducking, attack and release) are not in config. They are not marked initial, so W8
  decides where they live.
- `.claude/skills/engine-bible/SKILL.md` is not regenerated for the new section 4 subsection. The skill says the file
  wins. It is shared scope, so this is the lead's call.

## Blockers

None for fixtures and tests.
