---
name: coding-loop
description: Run Meridian's planned coding work as a continuous loop across wake-ups. Use when asked to keep coding, run the long coding run, continue the loop, or when a wake-up, a watchdog or a PR event points here. Works through .claude/loop/RUN_PLAN.md, records every question in OPEN_QUESTIONS.md without stopping, and ends with a Q&A list for the owner.
---

# Coding loop

The loop does Meridian's planned coding work one unit per wake-up. Each wake-up does one unit, saves its state to the repository, and schedules the next wake-up. A question never stops the loop: it is recorded, and work continues wherever the answer does not matter. When no unblocked work is left, the loop stops and the open questions go to the owner for a Q&A. A later run continues from the answers.

## The files

All loop state lives in `.claude/loop/`. Nothing the loop needs may exist only in the conversation, because the session can be compacted, reclaimed or restarted.

- `STATE.md`: `status` (`running`, `paused` or `finished`), `next_wake_at`, the trigger ids, the current task, and the unit counter.
- `RUN_PLAN.md`: the tasks in order, with their dependencies, acceptance checks and status. Parked tasks stay in the list.
- `OPEN_QUESTIONS.md`: every question, with its kind, the tasks it blocks, the default taken (if any) and its status.
- `RUN_LOG.md`: append-only. One entry per unit: time, task, commit, the checks run and their results, and what is still open.

Read `STATE.md` first, every time.

## Wake procedure

1. Read `STATE.md`. If `status` is `paused` or `finished`, stop. Do not schedule another wake-up.
2. Check PR `RTK23-dev/meridian#85` on its head: CI, reviews and merge state. Load the GitHub tools with ToolSearch if they are not listed (`select:mcp__github__pull_request_read`). Work any red check or open review thread under the PR rules in the session instructions before starting new work. A red PR the loop owns is work now.
3. Fetch the branch with `git fetch origin claude/nice-tesla-zrf6un` and compare it with your last commit. If the remote holds commits you did not make, stop and record it as a question. Do not force anything.
4. Pick the first task in `RUN_PLAN.md` whose dependencies are done and which is not parked. If there is none, go to *End of run*.
5. Do one unit of that task (see *Working a unit*).
6. Append to `RUN_LOG.md`. Update `STATE.md`: the unit counter, the current task and `next_wake_at`. Commit and push the state with the work.
7. Schedule the next wake-up (see *Re-arming*), unless the run has ended.

A PR event that woke the loop is handled in step 2, then the loop carries on from step 4. A PR event is never a reason to stop.

## Working a unit

- **Size.** A unit is one reviewable change: one split, one module, one gate, or one document. If a unit cannot be verified in one wake-up, split the task in `RUN_PLAN.md` and log the split.
- **Verify before pushing.** Run the checks that cover the files you changed: `npx eslint <files>`, `npm run typecheck`, and the focused tests with `NODE_ENV=development node --experimental-strip-types --test <files>`. Run the full gate (`npm run gate`, once task T1 exists) at the end of each task, not after each edit. Never claim a check passed unless you ran it.
- **Refactors keep their numbers.** Splits and moves must leave the test counts equal to the baseline in `RUN_PLAN.md`. A count that drops is a failure.
- **Commit** each unit with a message that says what changed and why. No model names in commits, PR titles or PR bodies. End each commit message with the `Claude-Session` trailer from the session instructions.
- **Push** with `git push -u origin claude/nice-tesla-zrf6un`. Retry network failures with 2, 4, 8 and 16 second waits, as the git rules say. Never push to any other branch.
- **Three failed tries** on the same task: park it, record the failure and what was ruled out in `OPEN_QUESTIONS.md`, and move on.

Never skip, disable or quarantine a test to get green. Never push an empty commit to kick CI.

## When a question comes up

Do not stop, and do not call `AskUserQuestion`. The loop runs unattended, and a question asked from the loop waits for an answer that never arrives. Sort the question into one of three kinds:

1. **Technical ambiguity inside the plan.** Take the most conservative reading and make the change in a way that is easy to reverse. Record it in `OPEN_QUESTIONS.md` as `decided by loop, confirm`, with the reason and what would change if the owner chose otherwise. Continue.
2. **Owner decision.** Anything the Bible's section 20.2 or the run plan reserves for the owner, and anything that changes product direction, a contract, a provider, spend, auth, or scoring. Do not guess. Record the options and what each one changes. Park the tasks that depend on it, and continue with the rest.
3. **Missing access or input**, such as a key, a reference reel or a live run. Record what is needed. Park the dependent work, and continue.

Every question has an id, a kind, the blocked tasks and a status: `open`, `decided by loop` or `answered`. The end-of-run Q&A is only as good as this list, so each entry must be specific enough to answer in one sentence.

## Hard stops

The loop never does these, whatever a task seems to need. Park the task and record why.

- Make a live provider call, spend money, or run any command that can reach a paid API. That includes `npm run e2e*`, `npm run engine:e1` without `-- --dry-run`, and any script given `--live`. `npm run live:readiness` is allowed because it calls nothing.
- Read, write or print a secret, a key or the contents of a `.env` file. Do not create or edit `.env` files.
- Publish, deploy, merge a pull request, close or reopen one, or change its draft state.
- Rewrite history, force-push, rebase, or push to a branch other than `claude/nice-tesla-zrf6un`.
- Change a zod contract in `src/engine/contracts/` or bump a contract version. Write a proposal under `docs/engine/` and park the task.
- Add or change an npm dependency. Park the task.
- Change provider, auth, scoring or JEV logic unless the task names it.
- Answer a Bible section 20.2 open question.
- Read keys from `process.env` in engine code, or call `fetch` anywhere except `src/engine/gateway/transport.ts`.
- Edit `src/routeTree.gen.ts` by hand.
- Delete, or wire up, any of the 45 test-only modules without an owner decision.

## Re-arming

Schedule the next wake-up with `send_later`, which survives a container restart. Use this message, unchanged:

> Coding loop wake. Read .claude/skills/coding-loop/SKILL.md and follow its Wake procedure. The run state is in .claude/loop/.

Delay: 20 minutes after a unit that changed code, and 60 minutes when the only thing left is waiting on CI or a reviewer. Before you arm a new wake-up, cancel the pending `wake_trigger` in `STATE.md` with `delete_trigger` if it is still listed. Then record the new trigger id as `wake_trigger` and the time as `next_wake_at`. This stops two wake-up chains from running side by side.

The watchdog is a recurring scheduled task, `watchdog_trigger`, created at the start of the run. It fires every two hours into this session with this message:

> Coding loop watchdog. Read .claude/loop/STATE.md. If status is running and next_wake_at is more than 30 minutes in the past, follow the Watchdog section of .claude/skills/coding-loop/SKILL.md. Otherwise do nothing.

## Watchdog

If `status` is not `running`, stop. If `next_wake_at` is in the future, or less than 30 minutes in the past, stop: the wake-up chain is alive. Otherwise run the Wake procedure, which arms a new wake-up as usual. Do not message the owner when you do nothing.

## End of run

The run ends when every task is done, when no task is unblocked (the rest are parked), when the owner sets `status` to `paused` or `finished`, or when a hard stop or the session's allowance ends it.

To end the run:

1. Set `status: finished` in `STATE.md`, with the reason.
2. Cancel the pending `wake_trigger` and delete `watchdog_trigger`.
3. Write the final entry in `RUN_LOG.md`: units done, the commit range, the checks run, and what is parked and why.
4. Commit and push the state.
5. Send the owner one message: what was done, the commit range, and the open questions, numbered, each answerable in a sentence. Then stop.

If the session's allowance is running out, stop background processes, delete build output and caches you no longer need, commit and push, and say so in that final message.

## Q&A and continuing

When the owner answers in chat, the session resumes from that message and does the following:

1. Record each answer in `OPEN_QUESTIONS.md` with the date, and set its status to `answered`.
2. Move every task the answer unblocks back to `pending` in `RUN_PLAN.md`. If an answer changes the plan, write the change into the plan itself.
3. If an answer reverses a decision the loop took, reverse it in the code in its own commit, and record that in the log.
4. Set `status: running`. Arm a wake-up. If the watchdog was deleted, create it again and record its new id.

## Checks before any push

- The focused checks for the changed files pass.
- `git diff --stat` shows only the files the unit meant to change.
- Test counts are not below the baseline in `RUN_PLAN.md`.
- The commit message says what changed and why, and names no model.
