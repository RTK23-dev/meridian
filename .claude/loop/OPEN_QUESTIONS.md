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
