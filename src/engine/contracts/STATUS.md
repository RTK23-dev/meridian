# STATUS: engine contracts (W1, with config)

## Model choice: contract version `engine-contracts@7` (current)

Branch `worktree-agent-ace5eed12ff323956`, fast-forwarded to `main` (6bf831f) before the change, so it carries Bible 10.5 and
the CLAUDE.md rule 3 change. Bible section 4 has the "v7 changes and migration" note. Not pushed; the lead merges.

### Changes (the lead's four items)

1. **Model choice on the asset spec (`assets.ts`).** `AssetSpec.modelChoice` is `modelChoiceSchema.nullable().default(null)`:
   `{ provider: 'openrouter', modelId (non-empty), source: 'orchestrator' | 'fallback', reason (1 to 500 characters), catalogReadAt
   (ISO time) }`, or null. A v6 spec with no key reads as null. Exports: `modelChoiceSchema`, `ModelChoice`,
   `modelChoiceSourceSchema`, `ModelChoiceSource`, `MODEL_CHOICE_SOURCES`, `MODEL_CHOICE_REASON_MAX`.
2. **Catalog candidate (`catalog.ts`).** `modelCatalogEntrySchema` and `ModelCatalogEntry`: `{ id, modelClasses (at least one),
   capabilities { minSeconds, maxSeconds, aspectRatios, resolutions, firstFrame, lastFrame, refsMax, audio }, price { unit, usd,
   sku }, readAt }`. Each capability is nullable. `price` is required; `usd` must be positive. A refinement refuses `maxSeconds`
   below `minSeconds`. Exports `catalogPriceSchema`, `catalogCapabilitiesSchema`, `CATALOG_PRICE_UNITS`, `catalogPriceUnitSchema`.
3. **Preference table (`config/model-preferences.ts`).** `modelPreferences` (`model-preferences@1`) with `ranked` per production
   class, all empty by owner decision (2026-10-16). `PREFERENCE_MODEL_CLASSES` lists the seven production classes.
4. **Version.** `CONTRACTS_VERSION = "engine-contracts@7"`. `config.test.ts` pins it and checks the preference table.

### Decisions for the lead

1. **The choice is carried by the asset spec, not the shot spec.** Bible 10.5 step 3 says "the shot spec carries the chosen model".
   The asset spec is the one the router consumes. The choice is made at produce time from a catalog read made then, the scene plan
   is written earlier and is immutable, and a chain shot (v5) has several paid calls, each with its own model. Say if the Bible text
   should read "the asset spec" (the Bible section 4 note asks the lead to reconcile).
2. **The literal stays `meridian.asset_spec/v1`.** The change is additive (the v5 chain change kept its literal too).
3. **The price rule.** `usd` must be positive, so a zero or missing rate is refused. It has no four-decimal limit: a per-token rate
   can be below a cent, and the USD money rule applies to amounts, not to rates. `sku` is nullable as specified; the catalog
   names it, so the owner's live run records whether it is present for video.
4. **Lip-sync has no preference row.** Bible 10.5 names the production classes as video, avatar, image and speech; lip-sync is
   chosen in E2. Add it when it is a production class.
5. **No schema literal on `ModelCatalogEntry`.** It is not an artifact. It is versioned by `CONTRACTS_VERSION` like `LedgerEntry`.
6. **The cache key is not changed (open).** `assetCacheKey` (10.4) reads the provider id, not `modelChoice`. The router must pass
   the chosen model's own id as the provider id (for example `openrouter:<modelId>`), so two models never share an entry. If the
   lead wants the key to read the choice, add `modelId` to the hashed object only when a choice is present: every v6 key stays the
   same. This is not done here, because it is a change to a function with a stored result.

### Typecheck follow-up (outside this folder, NOT edited here)

`npx tsc --noEmit` exits 2 with four errors. All four are the new required output key (`z.infer` makes `modelChoice` required),
and each is a one-line fix in a file this worktree may not write. The lead applies them:

- `src/engine/assets/firstLastFrame.ts:160`: add `modelChoice: null` to the `AssetSpec` literal.
- `src/engine/assets/firstLastFrame.test.ts:139`: add `modelChoice: null` to the `AssetSpec` literal.
- `src/engine/assets/test/recorded.ts:109`: add `modelChoice: null,` in the `assetSpec()` return, before `...overrides`.
- `src/engine/voice/voice.ts:120`: add `modelChoice: null` to the narration spec literal.

Runtime is not affected: the eleven test files that touch asset specs pass (see Tests).

### Tests (this worktree)

- `NODE_ENV=development node --experimental-strip-types --test` over every test file under `contracts/` and `config/`
  (`routes.test.ts`, `assets.test.ts`, `hash.test.ts`, `ids.test.ts`, `config.test.ts`, `invalid.test.ts`, `schemas.test.ts`):
  252 tests, 252 pass, 0 fail.
- The new cases: 7 model-choice rejections (unknown source, empty modelId, a provider other than openrouter, empty reason, reason
  over 500, a bad `catalogReadAt`, no source), 3 asset-spec rejections with a bad choice, 14 catalog rejections (missing or null
  price, zero and negative price, unknown unit, empty sku, no class, a class the contract lacks, `maxSeconds` below `minSeconds`, empty
  id, bad `readAt`, a capability left out, no capabilities block). Additive: a v6 spec reads as null; a catalog capability that is
  null stays null. The fixtures `assetSpecV6`, `modelChoice` and `modelCatalogEntry` join the round-trip test.
- Rejection reasons checked by hand: `price: expected object`, `price.usd: must be >0`, `source: expected one of orchestrator|fallback`.
- Consumers run in this worktree (not part of the required set): `assets/firstLastFrame`, `assets/providers/*` (avatarIv,
  openrouterImage, openrouterSpeech, openrouterVideo), `assets/router`, `assets/submit-settle`, `jobs/chain-store`,
  `jobs/handlers/produce-shot`, `jobs/handlers/variants-generation`, `jobs/runtime`: 157 tests, 157 pass.
- `npx eslint` on the ten changed TypeScript files: exit 0, no output.
- The full `npm test` was not run here; the lead runs it after merging.

### Live run: owner (no keys held by agents)

Nothing here calls a provider. The first live check is one catalog read of OpenRouter's video models: parse each entry into a
`ModelCatalogEntry`, and record how many rows the schema refuses (a row with no price must be refused, not guessed). Then one
choice on one shot, recorded with its catalog read time, and its bill set against its estimate.

## Chains: contract version `engine-contracts@5`

Branch `worktree-agent-a347022c3cbcf198e`, fast-forwarded to `code/beautiful-cori-1zfk11` (b4ee734) before the change, which is
where the engine's latest work sits (eng-plan-gaps-2 is an ancestor). Not pushed; the lead merges. Bible section 4 has the
"v5 changes and migration" note. Commit: see `git log` on the branch. The task is plan/STATUS.md item 5.

### The schema (`plan.ts`)

`ShotSpec.source` is a discriminated union on `kind`, now with a fifth member:

    { kind: 'chain', calls: ChainCall[] }     // at least two calls (CHAIN_MIN_CALLS)
    ChainCall  = { output, modelClass, prompt, refs: ChainInput[], firstFrame?, lastFrame?, takes: 1 | 2 }
    ChainInput = { kind: 'asset', uri } | { kind: 'output', output }
    output     = /^[a-z][a-z0-9_]{0,39}$/

Refused at parse time: a repeated output name, and an output input that no earlier call of the same chain makes (unknown,
a later call's, or the call's own). `chainProblem(calls)` returns the first problem with its call index. `chainInputsOf(call)`
lists a call's inputs. Exported from `index.ts` through `plan.ts`.

### Changes (the lead's list)

1. **Schema.** As above. The literal stays `meridian.scene_plan/v1` (additive). Every single-call shot is unchanged: a test parses
   each shot of `scenePlanFixture` and checks the parse is equal to its input.
2. **Version.** `CONTRACTS_VERSION = "engine-contracts@5"`. `config.test.ts` pins it.
3. **Fixtures.** `fixtures/ids.ts`: `shotCartoonChain` (shot_ 16) and `shotStopChain` (shot_ 17). `fixtures/chain.ts`:
   `cartoonChainShotFixture` (keyframe, then a clip that starts from it; 0 to 3 s), `stopMotionChainShotFixture` (30 image-edit
   frames, each reading the hero and the frame before; 9 to 11.5 s), and `scenePlanChainFixture` (the fixture plan with its shot 1
   drawn by the cartoon chain; `estimatedUsd` 0.3204 = 0.1188 + 0.2016). `scenePlanChain` is in the `fixtures` map, so the round
   trip and the top-level parse tests cover it.
4. **Estimate (`budget/estimate.ts`).** One budget line per call. A chain's calls are generated (redo allowance). A single-call
   shot keeps one line at its old price.
5. **Tests.** `schemas.test.ts`: additive parse, chain round trip, unknown output refused with the name in the message.
   `invalid.test.ts`: 17 chain rows (one call, no calls, unknown/own/later output, repeated name, bad names, takes 3, empty
   prompt, unknown model class, bare string input, unknown input kind, empty asset uri, a plan with a bad chain).
   `budget/estimate.test.ts`: each link priced, takes priced per link, 24 per-image links priced 24 times, a stop-motion
   chain refused and named (token-priced frames), an unknown output refused before pricing, the single-call shot unchanged.

### Consumers changed outside the contracts folder (minimal: typecheck, and fail closed)

- `review/gates/plan.ts`: `shotUsesProductImagery` (chain case); the text rule checks every call's prompt
  (`generationPromptsOf`); the downgrade rule counts a chain as generated (`isGeneratedShot`). Tests in `gates/plan.test.ts`.
- `review/slideshowRisk.ts`: `shotText` (chain case: the calls' prompts).
- `jobs/handlers/plan.ts`: `shotSummaryOf` refuses a chain with `not_implemented`, and the summaries are built before the
  scene plan artifact is written, so a refused plan is not stored. Test in `plan.test.ts`.
- `jobs/e3-pipeline.test.ts`: the test's summary helper refuses a chain (this fixture has none).
- `config/config.test.ts`: the version pin.

### Still to change before the planner may write a chain (not done here; the plan refuses a chain until then)

- `edit/editor.ts` lines 136 and 162: media shots are generate or stock, so a chain is not media and has no take.
- `deliver/manifest.ts` line 110: a generate shot's manifest row.
- `variants/expand.ts` line 134: which shots a hook or product variant regenerates.
- `jobs/handlers/check-take.ts` line 41: which shots get a take check (generate or stock).
- `jobs/orchestrator.ts` `needsProduce` and `providerKeyFor`, and `jobs/validate.ts` (the summary enum): a chain needs a produce job.
- `jobs/handlers/produce-shot.ts`: makes one take per shot today. It must make the calls in order and resolve each output input.
  A chain falls through to its final refusal (line ~529).
- `review/slideshowRisk.ts` `isStill` and `isMovingFootage`: a chain is not classified as still or moving footage.
- `plan/cost.ts` `RECIPES`: `cartoon_generated` is priced as one video call, without the keyframe. `estimatedUsd` must match the
  estimate once the plan builds the chain.
- `plan/sources.ts` `buildSource` still refuses both chain types and names the chain builders (`cartoonGeneratedChain`,
  `stopMotionChain`). Their calls are not yet in the `chain` shape; the builder that makes the shape is a later change.

### Decisions for the lead

1. **The literal.** Kept at `/v1` because the change is additive (v2 and v4 did the same). Say if you want `meridian.scene_plan/v2`.
2. **Chain inputs are typed.** A chain's `refs` are `ChainInput[]`, not `string[]` as a generate source's are, so an output name
   cannot be mistaken for an asset uri and an unknown name is refused. Say if you want the strings form with a prefix instead.
3. **The closing `stopmotion.player` is not in the contract.** A chain carries calls only. Where the component sits (a `then`
   field on the chain, or a second shot) is a decision for the lead and the component owner.
4. **One budget line per call.** `BudgetLine` has no call id, so the lines of one shot differ only by provider and amount. The
   ledger's per-call entries (eng-pipeline) need a call id when the produce stage writes them.
5. **Minimum two calls.** A one-call chain is a generate source. No maximum is set; the stop-motion range (24 to 36) is in
   `plan/tables.ts` (`STOP_MOTION_FRAMES`), and the budget bounds the cost.

### Owner items

- **Price for the image-edit class.** It is token-priced (`prices.ts`, price null), so a stop-motion chain's estimate refuses until
  the owner sets a price. The contract accepts the chain; the estimate does not guess.

### Tests (this worktree)

- Final run: `NODE_ENV=development node --experimental-strip-types --test` over `contracts/*.test.ts`, `budget/*.test.ts`,
  `config/*.test.ts`, `review/gates/*.test.ts`, `review/slideshowRisk.test.ts`, `jobs/handlers/plan.test.ts`,
  `jobs/handlers/estimate-reserve.test.ts`, `jobs/e3-pipeline.test.ts` and `jobs/scenarios.test.ts`: 502 tests, 502 pass, 0 fail.
- `npx tsc --noEmit`: exit 0. `npx eslint` on the 16 changed TypeScript files: exit 0.
- The full `npm test` was not run here; the lead runs it after merging.

### Live run: owner (no keys held by agents)

Nothing here calls a provider. The first live check for a chain is one cartoon_generated shot: the keyframe call, then the clip
from that keyframe (the first frame is the keyframe's take). Record each call's ledger entry, its estimate and its actual cost,
and check the two calls against the estimate's two lines. The stop-motion chain waits for the image-edit price.

## E3 follow-up: contract version `engine-contracts@4`

Branch `eng-e3-contracts-2`, from `origin/code/beautiful-cori-1zfk11` (1a13ebb), then merged with that branch at f6b70d5 (E4).
Not pushed; the lead merges. Bible section 4 has the "v4 changes and migration" note. Commit: see `git log` on the branch.

### Changes (the lead's list, and the review move)

1. **`frame_reader` in `CLAUDE_ROLES` (`ledger.ts`).** A Haiku vision role on the `llm.check` route. It reads captions, shake and
   speed ramps from sampled frames, as measurements only. Bible 11.1 has its row (the tokens and cost are proposals). Fixture:
   `ledgerEntryFrameReader` (`led_` fixture 35). No prompt and no role file are written here (they belong to the analyze role
   work). Bible 6.2 step 6 and 8.1 say OCR; the v4 note says the reading is `frame_reader`.
2. **Editor constants into `config/thresholds.ts` (`thresholds@3`, `thresholds.editor`).** Each value has its Bible section or is a
   Tunable with bounds (see "Replacements" below for every line in `edit/`). The Bible gives cut snap 80/250/120 ms, the fit
   shares 0.5 and 1.5, the hook times 500 and 300 ms, the loop 500 ms, the 10 per cent jitter and the 18 dB duck, so those are
   plain. Everything else is a Tunable with bounds that the lead confirms.
3. **Plan lease (`thresholds.jobs.leaseMs.plan`).** `3 * CLAUDE_LEASE_MS` = 360 000 ms. The plan job runs up to three Claude
   calls (request classification, planner, director check) under one lease. The constant `CLAUDE_LEASE_MS` is 120 000 and the
   plan lease follows it. The comment in `thresholds.ts` says so.
4. **Editor decisions (`plan.ts`, `Decision.by`).** `by` gains `editor` (`DECISION_AUTHORS`, `decisionAuthorSchema` exported).
   The subject is an EDL clip: `Decision.at` holds the clip id, as it already holds a beat or shot id for the planner and the
   director. No field is added. An editor decision with no real score uses `alternatives: []`; a score is never invented.
   Fixture: `editorDecisionFixture` (subject `c_base_3`, a clip of `edlFixture`), in the manifest fixture's decisions. Tests
   check the subject is a clip of the EDL, and that an unknown author, an empty subject and an infinite score are refused.
5. **Review move (`review/tuning.ts` into `thresholds.slideshow`, 12.3).** `codedRunMax` is plain 4 (Bible 19 E4: five coded
   shots in a row is blocked). The six slideshow weights are Tunables, each 1 with bounds 0.5 to 2 (the floor keeps the mean's
   divisor positive). `contentWordMinLength` is a Tunable, 4 with bounds 3 to 6. The word list, the component list, the effect
   kinds, the still model classes, the claim types and the prefix are documented data. `config.test.ts` checks that the effect
   kinds, model classes and claim types are members of the contract enums. `REVIEW_TUNING.version` has no reader and is dropped.
6. **Version.** `CONTRACTS_VERSION = "engine-contracts@4"`. `meridian.manifest/v2` keeps its literal (see decisions).

### Decisions for the lead

- **`Decision` has no typed subject field.** `at` already carries the subject for the other authors. A typed `subject: { kind, id }`
  would be a further change (v5). Say if you want it.
- **The manifest literal stays `/v2`.** Its accepted roles and decision authors widen; no v2 manifest becomes invalid. Say if the
  literal should move to `/v3`.
- **Migrations for eng-pipeline (none written here).** (a) `engine_decisions.decided_by` (migration 0077) allows only scorer,
  director and human; a migration must add `editor` before an editor decision is written. (b) If a role column gets a check, it
  must include `frame_reader`.
- **Bible 5.1's lease list does not name `plan`.** Section 4's v4 note does. The Bible text is not edited beyond section 4 and the
  11.1 row, so the lead decides whether 5.1 gets a line.
- **The editor's EDL identity.** The editor hashes `EDIT_TUNING.version` into the EDL id. The replacement is `thresholds.version`,
  so every EDL id changes once, and then again on every thresholds bump (the same rule as Bible 16.3). Edit tests that pin an
  EDL id will need the new value. The alternative is a fixed editor version key in `thresholds.editor`.
- **Not moved from `edit/tuning.ts`.** `drawableTransitions` and `drawableEffects` are compiler capabilities (the list the
  compiler draws), not numbers. They stay in `tuning.ts` with `CaptionBand`. The lead may move them into `compose/compiler.ts`.
- **Not in the code yet (Bible 8.2, noted for the editor).** Ducking attack 150 ms and release 400 ms (step 11), and the J and L cut
  offsets of 4 and 3 frames (step 7). The editor does not place them; they are not in config.

### Replacements for the lead (not made here: `edit/` and `review/` belong to other workstreams)

Verified in a scratch script: every path below resolves, and every moved value equals the value it replaces (`thresholds.version`
is `thresholds@3`; `jobs.leaseMs.plan` is 360000). The `.value` suffix is needed where the thresholds entry is a Tunable.

`src/engine/edit/tuning.ts` keeps only the two capability lists and the `CaptionBand` type. Its new content:

    import { thresholds } from "../config/thresholds.ts";
    export const EDIT_TUNING = {
      drawableTransitions: ["hard", "fade", "whip"],
      drawableEffects: ["punch_in", "shake", "flash"],
    } as const;
    export type CaptionBand = keyof typeof thresholds.editor.geometry.captionTopShare;

Replacements (`EDIT_TUNING.X` becomes the path shown; the import of `thresholds` is added in each file):

| File and line | Old | New |
| --- | --- | --- |
| `edit/words.ts` 26 | `EDIT_TUNING.cutSnap.gapMinMs` | `thresholds.editor.cutSnap.gapMinMs` |
| `edit/words.ts` 56 | `EDIT_TUNING.cutSnap` | `thresholds.editor.cutSnap` |
| `edit/words.ts` 72 | `EDIT_TUNING.cutSnap.beatWindowMs` | `thresholds.editor.cutSnap.beatWindowMs` |
| `edit/words.ts` 98 | `EDIT_TUNING.captions.breakPattern.test(word.text)` | `new RegExp(thresholds.editor.captions.breakPattern).test(word.text)`, built once at module level |
| `edit/editor.ts` 126, 127 | `EDIT_TUNING.captions.maxWordsPerCaption` (twice) | `thresholds.editor.captions.maxWordsPerCaption.value` |
| `edit/editor.ts` 204 | `EDIT_TUNING.punch.minScale` | `thresholds.editor.punch.minScale.value` |
| `edit/editor.ts` 205 | `EDIT_TUNING.punch.intensityDivisor` | `thresholds.editor.punch.intensityDivisor.value` |
| `edit/editor.ts` 206 | `EDIT_TUNING.punch.jitterShare` | `thresholds.editor.punch.jitterShare` |
| `edit/editor.ts` 207 | `EDIT_TUNING.punch.floorScale`, `EDIT_TUNING.punch.maxScale` | `thresholds.editor.punch.floorScale.value`, `thresholds.editor.punch.maxScale.value` |
| `edit/editor.ts` 231 | `EDIT_TUNING.effectClashMs` | `thresholds.editor.effectClashMs.value` |
| `edit/editor.ts` 247 | `EDIT_TUNING.version` | `thresholds.version` (see the EDL identity decision) |
| `edit/editor.ts` 305 | `EDIT_TUNING.hook.captionByMs` | `thresholds.editor.hook.captionByMs` |
| `edit/editor.ts` 340 | `EDIT_TUNING.captions.maxPerClip` | `thresholds.editor.captions.maxPerClip.value` |
| `edit/editor.ts` 349 | `EDIT_TUNING.loopMs` | `thresholds.editor.loopMs` |
| `edit/editor.ts` 401 | `EDIT_TUNING.music.baseGainDb` | `thresholds.editor.music.baseGainDb.value` |
| `edit/editor.ts` 402 | `EDIT_TUNING.music.duckDb` | `thresholds.editor.music.duckDb` |
| `edit/time.ts` 20 | `EDIT_TUNING.fit.shortShare` | `thresholds.editor.fit.shortShare` |
| `edit/geometry.ts` 18, 48 | `EDIT_TUNING.geometry`, `EDIT_TUNING.geometry.assumedFaceBox` | `thresholds.editor.geometry`; every Tunable read gets `.value` (`captionLeftShare`, `captionWidthShare`, `captionHeightShare`, `captionTopShare[band]`, and the four `assumedFaceBox` fields, which replace the spread with `{ x, y, w, h }`) |
| `edit/geometry.test.ts` 38 | `EDIT_TUNING.geometry` | the same mapping, with `.value` |
| `edit/rules.ts` 300, 303 | `EDIT_TUNING.loudnessRoundingLufs` | `thresholds.editor.loudnessRoundingLufs.value` |
| `edit/rules.ts` 311 | `EDIT_TUNING.maxDrawableGainDb` | `thresholds.editor.maxDrawableGainDb.value` |
| `edit/rules.ts` 319 | `EDIT_TUNING.music.duckDb` | `thresholds.editor.music.duckDb` |
| `edit/rules.ts` 416 | `EDIT_TUNING.hook.captionByMs` | `thresholds.editor.hook.captionByMs` |
| `edit/rules.ts` 423 | `EDIT_TUNING.hook.motionWithinMs` | `thresholds.editor.hook.motionWithinMs` |
| `edit/rules.ts` 482, 488 | `EDIT_TUNING.drawableTransitions`, `EDIT_TUNING.drawableEffects` | unchanged (they stay in `tuning.ts`) |
| `edit/pieces.ts` 123 | `EDIT_TUNING.fit.shortShare` | `thresholds.editor.fit.shortShare` |
| `edit/pieces.ts` 199, 220 | `EDIT_TUNING.fit.longShare` | `thresholds.editor.fit.longShare` |
| `review/slideshowRisk.ts` 13 | `import { REVIEW_TUNING } from "./tuning.ts"` | `import { thresholds } from "../config/thresholds.ts"` |
| `review/slideshowRisk.ts` 53 to 57 | `REVIEW_TUNING.motionEffectKinds`, `stillModelClasses`, `textLedComponents`, `cinematicClaimTypes`, `stopWords` | `thresholds.slideshow.` of the same name |
| `review/slideshowRisk.ts` 110 | `REVIEW_TUNING.contentWordMinLength` | `thresholds.slideshow.contentWordMinLength.value` |
| `review/slideshowRisk.ts` 124 | `REVIEW_TUNING.motionModelClassPrefix` | `thresholds.slideshow.motionModelClassPrefix` |
| `review/slideshowRisk.ts` 141, 242 | `REVIEW_TUNING.codedRunMax` | `thresholds.slideshow.codedRunMax` |
| `review/slideshowRisk.ts` 232 | `REVIEW_TUNING.slideshowWeights` | `thresholds.slideshow.weights`; the two `weights[item.dimension]` uses (lines 233 and 235) get `.value` |
| `review/slideshowRisk.test.ts` 4, 54, 62 | `REVIEW_TUNING` | `thresholds` and `thresholds.slideshow.codedRunMax` |

After the replacements, delete `src/engine/review/tuning.ts`, and `src/engine/edit/tuning.ts` keeps only the content above.

### Tests (this worktree, this follow-up)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/contracts/**/*.test.ts' 'src/engine/config/**/*.test.ts' 'src/engine/budget/**/*.test.ts'`:
  292 pass, 0 fail (the E3 baseline was 274).
- `... 'src/engine/review/**/*.test.ts' 'src/engine/edit/**/*.test.ts' 'src/engine/plan/**/*.test.ts'`: 480 pass, 0 fail. These consume
  the changed fixtures (`manifestFixture` decisions, the new fixture ids) and pass unchanged.
- `npm run typecheck`: exit 0. `npm run lint`: exit 0, 0 errors, 4 warnings, all in `src/components/` (pre-existing).
- The full `npm test` was not run here; the lead runs it after merging.

### Live run: owner

Nothing in this follow-up calls a provider, so there is no live step for the contracts. The owner confirms the `frame_reader`
tokens and cost (12k in, 1k out, about $0.02 at Haiku's proposed rate) with one billed analyze call, when the role exists.

## Phase E3: contract version `engine-contracts@3`

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
