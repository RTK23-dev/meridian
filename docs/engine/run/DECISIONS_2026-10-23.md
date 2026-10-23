# Decisions made on the owner's behalf, 2026-10-23

Made under the owner's direction of 2026-10-23 (see `REPLAN_2026-10-23.md`). Each one is recorded so the owner can overturn it. None
is verified by a live run.

## D1. Veo is off by default, as a setting

- The owner said to keep Veo off for now. The default disabled list is `google/veo` (the OpenRouter family). It is a workspace policy
  value, so the owner can turn it on without a code change.
- The route table's Veo fallbacks stay in code as names, and the chooser skips them while the family is disabled. Nothing is deleted.

## D2. Budgets are soft limits with a tolerance

- Overrun tolerance: the larger of `percent` of the target and `cents`. Initial values: 10 percent and 25 cents. A workspace policy value.
- Within target plus tolerance (the allowance), work proceeds. Beyond the allowance, the run pauses and asks for approval. Nothing is
  refused for a small overrun. This replaces the exact cap in the executor, the planning call, the run reservation, the month
  check and the brief path's cap mode.
- Recorded against CLAUDE.md working rule 3 and the Bible's budget wording, which say "hard limits". The owner's direction supersedes
  them for these flows. The documents are updated in B6.

## D3. Category budgets are optional and delegated

- The brief may carry copy, creative and voice budgets. Unset categories are the orchestrator's to split under the total.
- Copy is analysis and script. Creative is visual, video and avatar. Voice is voice. Edit, compose, render and reference make no
  model call, so they have no category.

## D4. The plan schema does not change

- `orchestrator-plan@1` is unchanged. The category split travels in the brief. The validator checks the sums from the step estimates.

## D5. The planner prompt moves to @3

- @3 adds the model brief and the budget split. The role's `prompt.version` moves from 2 to 3. D9 (the adoption of @2 and the queued
  state rule) is not resolved here.

## D6. Model brief policy

- The brief names the newest model in each class that the public listing shows and that the policy does not disable. An older model
  is named only when it is clearly cheaper and the newer one would not fit the step's allowance. Quality notes cite a source or say
  "unverified". No quality claim is made without a source.

## D7. Rights and calibration are not changed

- Per-creative attestation (point 2) and the calibration bootstrap (point 3) are untouched, as the owner directed.
