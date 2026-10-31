# Open questions

Every question the loop could not settle alone. Each one says what it blocks and what the loop did in the meantime. Answer in chat; the next run records the answer here and unblocks the tasks.

Status: `open`, `decided by loop` (the loop chose, and you can confirm or reverse it) or `answered`.

## Q1: Contract change for preset fields
- Kind: owner decision. Status: `open`.
- Blocks: any new preset field in `src/engine/contracts/`. No task in this run needs one unless you approve it.
- Default taken: none. The run works on the existing contracts (T11).
- Question: if the preset inventory (T10) finds fields that presets need, do you approve `engine-contracts@12`, with a Bible section 4 migration note?
- Options: (a) approve, once T10 has named the fields; (b) keep presets on the existing contracts; (c) defer to a later run.

## Q2: E1 dry-run policy
- Kind: owner decision. Status: `open`.
- Blocks: nothing in this run. The gate reports the dry run as known red.
- Default taken: none.
- Question: in `docs/FIRST_TEST_RUN.md`, step 6, do you set the HyperFrames price per minute, or let the dry run report the render-bill check as `not proven offline`?
- Options: (a) set the price in `src/engine/config/prices.ts` (the dry run stays strict and stays red until a bill exists); (b) report the bill check as not proven offline.

## Q3: The 45 test-only modules
- Kind: owner decision. Status: `open`.
- Blocks: nothing. Left untouched.
- Question: for each module listed in `docs/STATE_2026-10-28.md`, section 6A, do you want it wired into a product path, or deleted?
- Options: (a) per module, wire or delete, one list; (b) leave all of them for a later run.

## Q4: Engine-ops E6 server functions
- Kind: owner decision. Status: `open`.
- Blocks: nothing. Left untouched.
- Question: do the E6 server functions get a UI caller, or are they removed?
- Options: (a) wire them to a screen; (b) remove them.

## Q5: Export package and disclosure gate
- Kind: owner decision. Status: `open`.
- Blocks: nothing. Left untouched.
- Question: the export package (FACTORY.md versus the CSV exports) and the disclosure gate are documented as delivery requirements, and neither has a caller. Keep and wire them, or drop the documented requirement?
- Options: (a) keep and wire; (b) drop the requirement and update the docs.

## Q6: PR #85 and the branch
- Kind: owner decision. Status: `open`.
- Blocks: nothing. The run stacks its commits on `claude/nice-tesla-zrf6un`, which is PR #85's branch.
- Default taken: stack on the branch. PR #85 now also carries this loop setup.
- Question: merge PR #85 when it is ready? If you merge it, the branch restarts from `main` and the run continues from there, under the session's branch rule.
- Options: (a) you merge it; (b) keep it open and the run keeps stacking; (c) split the loop setup into its own PR.

## Q7: Reference reels for research
- Kind: missing input. Status: `open`.
- Blocks: the reel-based part of T12. T12 uses hand-labelled fixtures in the meantime.
- Question: which reference videos may the loop analyse? They must be rights-cleared. The loop analyses them through the existing grammar and copies no content.
- Options: (a) name the reels or their source folder; (b) public sources only.

## Q8: One PR or several for this run
- Kind: owner decision. Status: `open`.
- Blocks: nothing.
- Default taken: one draft PR for the run, on the one branch. The session's branch rule allows no more branches without your permission.
- Question: keep one draft PR for the whole run, or open one per workstream (stability, configuration, splits, presets, research)?
- Options: (a) one draft PR; (b) one per workstream, with your permission for the extra branches.

## Q9: Permission rules for the unattended run
- Kind: owner action. Status: `open`.
- Blocks: unattended runs. Without these rules, a tool call that needs approval waits for you, and the loop stalls until you answer.
- Default taken: none. The loop does not edit its own permission settings.
- What happened: the session refused a write to `.claude/settings.json`, because it changes the session's own permissions. The loop did not work around that.
- Proposed rules, for you to add to `.claude/settings.json` and commit, or to approve in a session that can write it:
  - Allow: `npm run gate`, `npm run typecheck`, `npm run lint`, `npx eslint`, `npm test`, `npm run build`, `npm run live:readiness`, `npm run engine:e1 -- --dry-run`, the release acceptance script, `node --experimental-strip-types --test`, read-only git (`status`, `diff`, `log`, `show`, `rev-parse`), `git add`, `git commit`, and the fetch and push to `claude/nice-tesla-zrf6un` only.
  - Deny: force pushes, `git reset --hard`, rebase, amend, `npm run e2e*`, `npm run engine:e1` without `--dry-run`, `npm publish`, installs and `npm add`/`uninstall`, docker, and reads or writes of `.env` files.
- Alternative: run the session in Auto mode from the mode dropdown, if your organisation allows it.
- Options: (a) add the rules above; (b) run in Auto mode; (c) keep approving prompts as they come.

## Q10: The local source-tests step stops without a verdict
- Kind: technical ambiguity. Status: `decided by loop, confirm`.
- Blocks: T1's local verdict. Nothing else, once the decision in the next line stands.
- Decision (02:57 UTC): the local gate stopped in four runs, including the six-group run, with no verdict. The loop starts T3 to T9 now, and CI is their verification of record. Each unit runs the focused tests for the area it touches, and CI on the pushed head is checked at the next wake-up. The local gate verdict stays open under T1.
- What happened: the full gate stopped during the source-tests step three times (00:30, 00:43, 00:55). Each time the log had no stop message, so the process was killed hard. Memory was not short. CI runs the same tests in six shards, and they pass on the same head.
- Decision by the loop: the gate runs the source tests in the six shard groups that CI uses, one after another, and writes each group's totals. Each group is a smaller process. The gate's total must still reach the baseline of 6,649 passing tests.
- Reason: the single process is the only step that has stopped, and CI already runs it in six groups.
- What would change if you chose otherwise: if you would rather the gate report CI's verdict as the local verdict, say so, and T1 closes with that.
- Update, 07:22 UTC: the single-process gate stopped without a verdict twice more: at 06:49:55, at the start of source group 4, and at 07:14:00, in source group 0 of a detached re-run. Each group passes when run on its own, with the gate's own arguments, and no test process signals its group. The question stands. Your answer closes T1 on CI's verdict, or keeps the local gate open.

## Q11: Decisions the loop took in T12, for the lead to confirm
- Kind: technical decisions. Status: `decided by loop, confirm`.
- Blocks: nothing. Each decision is easy to reverse.
- What the loop did, and what would change if the lead chose otherwise:
  1. The 7-second longest-shot rule is a note, not a gate check, because it is a hypothesis (research note, section 4). Change: make it a gate check.
  2. The three hook values (`thresholds.hook`) are tunables with bounds the loop proposed: window 2 to 4 s, latest 4 to 8 s, longest shot 4 to 10 s. The lead confirms the bounds. The config test now counts 82 tunables (was 79).
  3. `thresholds@3` is unchanged. The lead decides whether this section warrants `thresholds@4`.
  4. A request with no script fails both hook checks as not evaluated (fail closed). The review status file says a brief's beat checks are not run. Question for the lead: can a brief reach the plan gate without a script? If it can, the hook checks should be skipped for it rather than failed.
  5. The on-screen text rate (5 to 10 words per second) is not checked, because the plan has no word timing on caption lines. It needs that timing first.

## Q12: Where the secret reads should live
- Kind: owner decision. Status: `open`.
- Blocks: the last step of T3 (the 25 direct reads of the secret names in src/lib and src/routes). Nothing else.
- Question: should these secret reads move behind one accessor in the credential folder, the same way the non-secret ones now go through `config/server-settings.ts`? The names are TOKEN_ENCRYPTION_KEY, EXTERNAL_SEMANTIC_KEY, EMAIL_API_KEY, CYCLONE_API_KEY and WEBHOOK_SECRET.
- Recommendation: yes. The credential resolver is the allowlisted reader for keys (AGENTS rule 4). The move changes no value, and each accessor returns the raw value, as the readers get it today. A test can then pin the set of secret readers.
- Options: (a) move them into a secret accessor in `src/lib/meridian/credentials/`, and extend the resolver allowlist; (b) leave them where they are, and the ratchet keeps counting them; (c) something else you name.

## Q13: The asset router's closure stays whole
- Kind: technical ambiguity. Status: `decided by loop, confirm`.
- Blocks: nothing. T9a is done.
- What the loop did: `engine/assets/router.ts` keeps `createAssetRouter` whole, the closure that runs submit, settle and produce over one shared state (about 770 lines). Only its types and pure helpers moved, to `router-types.ts` and `router-helpers.ts`. `router.ts` is now 831 lines.
- Reason: the three entry points share the closure's state, so splitting them apart would change how that state is shared, not only where the code sits.
- What would change if you chose otherwise: split the closure into submit, settle and produce modules that receive the shared state as a parameter. That is a behaviour-sensitive refactor, and it needs its own unit, with the retry and ambiguity tests as the check.

## Q14: The engine alerts use the proposed thresholds
- Kind: technical ambiguity. Status: `decided by loop, confirm`.
- Blocks: nothing. Part of R5 (the 45 test-only modules).
- What the loop did: `ops/alerts-sql.ts` and `ops/alerts.ts` are shown on `/engine-ops` as "Alerts right now", for the workspace, to any member. They use `proposedOpsThresholds` (version `ops-proposed@1`, `src/engine/ops/thresholds.ts`). The page says the thresholds are proposed and not accepted.
- Reason: Q3 asks for the modules to work. The thresholds are the only ones the engine has, and the file says the lead accepts them later. Showing them as proposed keeps the page honest.
- What would change if you chose otherwise: accept the numbers (move them into `config/thresholds.ts`), change them, or hide the section until they are accepted.

## Q15: The batch planner runs when the page is read, not when a request starts
- Kind: technical ambiguity. Status: `decided by loop, confirm`.
- Blocks: nothing. Part of R5.
- What the loop did: `ops/batch.ts` is shown on `/engine-ops` as "Batch requests". The count is the workspace's requests with batch priority (`engine_requests.priority`) in the last seven days. Each one is planned for OpenRouter, the only route in the batch table. The planner says no for OpenRouter (support unknown, no executor), so every batch request is shown as a normal call, with the planner's reason. A batch is never counted unless the planner makes one.
- Reason: the planner is not called at request start (`src/engine/api/start.ts` does not call it), so there is no stored plan to read. Adding a call there would change the engine's start path, which is not part of this unit.
- What would change if you chose otherwise: call `planBatch` when a request starts, and store the plan on the request. That needs a small engine change and a place to store the plan, which is a contract question for you.

## Q16: Record the bucket on each provider call, so concurrency can be proposed
- Kind: owner decision. Status: `open`.
- Blocks: the concurrency proposals on `/engine-ops` can move no size until this is decided. They are held at every size today. Nothing else is blocked.
- What the loop found: every OpenRouter target in `src/engine/config/routes.ts` names no model (the model is chosen at run time), so the static route table maps no provider call to a bucket. `engine_provider_attempts` does not store the bucket, so a call cannot be matched to one. In this workspace's last hour, the page shows the calls and that none matched.
- Options: (a) approve a migration that adds a bucket column to `engine_provider_attempts`, and have the gateway or the router write it on each call. Then the page can propose sizes from measured 429s. (b) Keep the proposals held, and accept that concurrency stays as it is. Growth also needs saturation measured from `engine_bucket_leases`, which is a separate step the loop has not built.
- Why the loop did not choose: the change is a database migration on the engine's call path. That is a schema decision, so it is the owner's.

## Q17: Four learning modules: wire them, or leave them out?
- Kind: owner decision. Status: `open`.
- Blocks: nothing. The four modules stay as they are, with no caller, until you decide.
- What each one does, in plain words:
  - `guardrails.ts` finds test and fixture records, such as a row whose provider is "fixture" or whose name says "synthetic". Today no learning input filters them out, so such a row could shape what learning learns. Wiring the filter changes learning, which is a scoring decision.
  - `parameters.ts` reads and writes the learned model parameters (table `model_parameters`), from seed prior to retired. Wiring it changes which parameters the engine uses, which is scoring.
  - `organic-telemetry.ts` updates formula beliefs from the results of organic posts. Wiring it changes learning.
  - `fatigue.ts` estimates whether an angle is tired, from total impressions, active ads, the click-rate drop and days active. It suggests SCALE, MONITOR, REFRESH_HOOK or PAUSE. Showing that is a product direction, and the per-angle impression totals it needs are not assembled yet.
- Options: (a) wire `guardrails` first as a filter on learning input, and show on the learning page how many rows it would exclude, so you can see whether test data is in use. (b) Show `fatigue` as a suggestion only. (c) Leave all four out and delete them later.
- The loop recommends (a). It changes nothing until you see the count.

## Q18: The studio core loop and the deep study: keep as harnesses, or wire them to live providers?
- Kind: owner decision. Status: `open`.
- Blocks: nothing. Both modules stay as they are, with no caller, until you decide.
- What each one does, in plain words:
  - `src/lib/meridian/studio/loop.ts` runs the studio's core loop (brief, image, video, review, publish). It runs on test image and video providers, a test embedding and a fake publisher. Its helpers (retry, dead image, calibration) show what those fakes do. Wiring it into the product now would show fixture output as real results, which the no-fake-success rule forbids. The parts it uses (whitespace, judgment, calibration) are product code and already have their own tests.
  - `src/lib/meridian/study/deep-study-service.ts` runs a deep study: a contrast analysis, then model-backed JEV judgment on eight questions, then a concept genome and an opportunity rating. Wiring it means model calls, which need your keys and your budget, and the rules keep those for a live run you start.
- Options: (a) build a live run you start yourself, with the budget cap set first, and show each step's cost. (b) Keep both as harnesses for the tests, and say so on the page. (c) Delete them later.
- The loop recommends (b) for now. Nothing in the product should show their output as a result.

## Q19: Three production planners: wire them, or keep them out?
- Kind: owner decision. Status: `open`.
- Blocks: nothing. The three modules stay as they are, with no caller, until you decide.
- What each one does, in plain words:
  - `src/lib/meridian/production/route.ts` combines a text decision and a vision decision for one creative. Any REJECT rejects; any HUMAN_REVIEW sends it to a person; otherwise it is approved. Wiring it changes which creatives are approved, so it is an approval decision for you.
  - `src/lib/meridian/production/rework-engine.ts` plans 10 to 30 short reels from one creator's footage pack, by a formula card. It needs footage whose rights are known, which is the question from R4 (whether any footage counts as real). It also has a placeholder default music asset (`asset://audio/music-bed-upbeat-01.mp3`) that is not a real file.
  - `src/lib/meridian/production/voice-director.ts` plans speech tempo, energy and pauses for voiceover, targeting about 160 words a minute. It needs a voice: real creator audio, or a consented synthetic voice. The voice vendor is still an open decision.
- Options: (a) decide the footage-rights question (R4) and the voice vendor, then wire the rework engine and the voice plan behind them. (b) Wire `route.ts` as the approval rule, once you confirm that is the rule you want. (c) Keep all three out of the product and delete them later.
- The loop recommends (a) for the voice and the rework engine, after the footage and voice decisions, and (b) only if you confirm the rule.

## Q20: Two duplicate modules: delete them, or switch to them?
- Kind: owner decision. Status: `open`.
- Blocks: nothing. Both modules stay as they are, with no caller, until you decide.
- What each one is, in plain words:
  - `src/lib/meridian/jobs/durable.ts` is a job queue held in memory (an array that is lost on restart). The product already runs its jobs through the Postgres worker, which is the queue the rules name. Using this one would build a parallel pipeline, which AGENTS forbids.
  - `src/lib/meridian/video/scene-frames.ts` picks four frames from a video, one per quarter, by the most relevant scene. The product already picks frames for its visual checks in `decisions/frames.ts`, which image QC uses. Switching would change which frames every visual judgment reads, so it changes scoring.
- Options: (a) delete `jobs/durable.ts`, since the Postgres worker is the queue. (b) Delete `video/scene-frames.ts`, and keep `decisions/frames.ts`. (c) Compare the two frame selectors on recorded videos first, and switch only if the scene-based one is better and you approve the change to scoring.
- The loop recommends (a) and (b). Deletion needs your decision, so nothing is deleted.

## Q21: The flow nodes and the seed priors: delete the flow, keep the priors as a registry?
- Kind: owner decision. Status: `open`.
- Blocks: nothing. Both modules stay as they are, with no caller, until you decide.
- What each one is, in plain words:
  - `src/lib/meridian/flow/nodes.ts` is a node graph for source, grading, planning, production, gate, publish and organic publish. Those are the stages of the Factory, which is the research-led pipeline the project already runs. Using this would build a parallel pipeline, which AGENTS forbids.
  - `src/lib/meridian/grading/priors.ts` lists the heuristic starting values for hook retention, speech pace (140 to 185 words a minute) and niche view baselines. Each is labelled as a seed, not a fitted weight. Scoring would use them only once a calibration report supports them (AGENTS rule 9). Note: the voice module (`production/voice-director.ts`, Q19) uses 140 to 180 words a minute, so the two modules disagree on the upper bound.
- Options: (a) delete `flow/nodes.ts`, since the Factory covers those stages. (b) Keep `priors.ts` as the labelled registry, and wire it into scoring only with a calibration report. (c) Reconcile the speech-pace range (140 to 180, or 140 to 185) before either module uses it.
- The loop recommends (a), (b) and (c).

## Q22: Two duplicate modules: delete them?
- Kind: owner decision. Status: `open`.
- Blocks: nothing. Both modules stay as they are, with no caller, until you decide.
- What each one is, in plain words:
  - `src/lib/meridian/intelligence/cluster.ts` groups creatives by similarity, with a threshold of 0.72. The product already groups them in `intelligence/whitespace.ts` (`clusterFingerprints`), which the opportunity engine and the studio loop use. This file is a second grouping of the same kind.
  - `src/lib/meridian/jev/calibration.ts` computes Brier score, log loss and reliability. The product already computes these in `learning/calibration-report.ts`, which the calibration screen uses. This file is a second copy of that work. (Correction, 17:04: `calibration/report.ts` has no product caller either. It is on the no-caller list in section 6A and is not the one the screen uses.)
- Options: (a) delete `cluster.ts` and `jev/calibration.ts`, and keep the product versions. (b) Keep them only as test references, and say so in their headers. (c) Compare the two versions on recorded data first, and merge only if they disagree.
- The loop recommends (a). Nothing is deleted until you decide.

## Q23: The organic Instagram group: approve the paid gather, or keep it out?
- Kind: owner decision. Status: `open`.
- Blocks: nothing. The eight `organic/*` files and their entry point, `src/lib/meridian/factory/instagram-volume.ts`, stay as they are, with no caller.
- What the group does, in plain words:
  - `factory/instagram-volume.ts` (the Factory's Instagram gather, from NORTH_STAR step 1 and 2) asks Apify for about 1,000 Instagram reel candidates per niche per week. It stores each one with its creator's baseline, and rates it. It fails closed without an Apify key. Running it spends money on Apify, so it is a live paid call, which the hard stops keep for a run you start.
  - `organic/learning-bridge.ts` writes organic post results into learning, which the scoring uses. Wiring it changes learning.
  - The rest (creators, reel store, snapshots, comments, pipeline, control sets) support those two. `control-sets.ts` has no link to anything else.
- Options: (a) approve a small, budgeted Apify run that you start, with the cap set first and each cost shown, then wire the gather. (b) Keep the group out until the learning bridge's effect on scoring is decided. (c) Delete `control-sets.ts` now, since nothing uses it, and keep the rest.
- The loop recommends (b) for the bridge, and (a) only with a cap you set. Nothing is run and nothing is deleted.

## Q24: Evidence freshness labels, and tracked reel links at publish
- Kind: owner decision. Status: `open`.
- Blocks: nothing. Both modules stay as they are, with no caller, until you decide.
- What each one does, in plain words:
  - `src/lib/meridian/quality/evidence.ts` labels a piece of evidence as fresh, aging (over 30 days) or stale (over 90 days), as a duplicate, or as weak (under 40 characters). It rewrites no text. No screen shows these labels yet. Showing them changes what a reader sees, not any score.
  - `src/lib/meridian/shopify/reel-attribution.ts` gives each published reel a tracked link (UTM tags) and a unique 8-character keyword for direct messages, stored once per reel (migration 0092). Its own header says the publish step should call it, and that the publish files belong to another workstream. Wiring it changes the caption or bio link of every reel published from then on. That is an outward change, so it needs your approval.
- Options: (a) show the freshness labels on the research evidence list. (b) Approve the tracked links in the publish step, for new reels first. (c) Keep both out for now.
- The loop recommends (a), and (b) once you have confirmed the link text.


## Q25: A third calibration implementation: delete it?
- Kind: owner decision. Status: `open`.
- Blocks: nothing. `src/lib/meridian/calibration/report.ts` stays as it is, with no caller.
- What it does, in plain words: `calibrationReport(rows)` builds bins, a reliability curve, a Brier score and an expected calibration error from stored reviewer scores. It says in its own result that it is not applied to any threshold (`appliedToThresholds: false`), which matches AGENTS rule 9.
- Why it is a question: the calibration screen already uses `learning/calibration-report.ts`, which also computes Brier. `jev/calibration.ts` is a third copy (Q22). Having three calibration implementations means they can disagree.
- Options: (a) keep `learning/calibration-report.ts` and delete the other two. (b) Move the expected-calibration-error and reliability curve from this file into `learning/calibration-report.ts`, then delete this one. (c) Keep all three until the owner chooses which report the screen should show.
- The loop recommends (b), which keeps the one screen's report and the extra measure, and removes the copies.

## Q26: A local-disk file store, and a second logo matcher
- Kind: owner decision. Status: `open`.
- Blocks: nothing. Both files stay as they are, with no caller.
- Part A, `src/lib/meridian/storage/filesystem.ts`: a store that keeps media bytes on the server's disk, with signed keys, on the same object-store port the engine uses. The product keeps artifacts in Google Drive (`docs/FIRST_TEST_RUN.md`, step 4). Using this store would add a second storage location, which decides where your artifacts live. It is tied to the research-data storage question in `docs/data/RESEARCH_DATA_PLAN.md`.
- Part B, `src/lib/meridian/vision/logo.ts`: a second logo matcher (`compareLogoPng`, `locateLogo`). Image QC uses `measureLogo` in `vision/measure.ts`. Two matchers can disagree.
- Options: A: keep the Drive store as the only one, and delete `filesystem.ts`, or make a local store a deliberate choice for development. B: delete `vision/logo.ts`, keeping `vision/measure.ts`.
- The loop recommends B now. For A, it recommends deciding storage with the research-data plan (R7) first.

## Q27: The factory cost rollup and budget check: show them?
- Kind: owner decision. Status: `open`.
- Blocks: nothing. `src/lib/meridian/factory/cost.ts` stays as it is, with no caller.
- What it does, in plain words: `rollupCosts` adds up the cost of each factory stage, and `withinBudget` says whether spend is under a budget, in cents. Nothing in the product calls either one, so no screen shows these totals or enforces this budget.
- Why it is a question: a budget check is a spend control. Wiring it into the factory changes whether a run can start or continue, so it is a money decision for you (AGENTS: budgets are hard limits).
- Options: (a) show the stage-cost rollup on the factory board, read-only, and leave the budget check out. (b) Wire the budget check too, with the cap you set. (c) Delete the file.
- The loop recommends (a). The rollup is a read of costs already recorded, so it shows spend without changing any run.

## Owner answers, 2026-10-31

- Q1: the owner asked for examples first, before deciding. Examples are in the status reply. Still open.
- Q2: answered. Save every price the project holds as plain files, so they can be read offline (done in `docs/data/prices/`). The render price is not in our data, and it stays unknown.
- Q3: answered: make the 45 test-only modules work, or say clearly why one cannot be made to work. Round two of the run plan carries it.
- Q4: answered: make the E6 engine-operations functions work. Done as a page at `/engine-ops`.
- Q5: answered: make the export package and the disclosure gate work. Round two carries it.
- Q6: answered: open a new pull request once the changes are done. PR #85 stays as it is.
- Q7: answered: reference videos can be uploaded from this device or added by public link, and both are studied and graded. Round two carries it.
- Q8: answered: one draft pull request for the new work.
- Q9: answered: full coding permissions, with the hard stops still denied. Done in `.claude/settings.json`.
- Q10: answered: yes, the online CI result closes T1.
- Q11: answered: confirmed as decided by the loop.
- Q12: answered: move the five secret reads behind one accessor. Done in `src/lib/meridian/credentials/secret-settings.ts`.
- Q13: answered: keep the asset router whole, as decided.
