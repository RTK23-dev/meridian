# Decisions made on the owner's behalf, 2026-10-23

Made under the owner's direction of 2026-10-23 (see `REPLAN_2026-10-23.md`). Each one is recorded so the owner can overturn it. None
is verified by a live run.

## D1. Veo is off by default, as a setting

- The owner said to keep Veo off for now. The default disabled list is `google/veo` (the OpenRouter family). It is a workspace policy
  value, so the owner can turn it on without a code change.
- The route table's Veo fallbacks stay in code as names, and the chooser skips them while the family is disabled. Nothing is deleted.

## D2. Budgets are soft limits with a tolerance

Superseded by D12 on the same day: the percent and cents tolerance is removed, and a budget is a line.

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

## D8. A category's spend is counted from stored outputs and failed holds

- A stored output records its step's category (migration `0116`, nullable, additive). A failed paid step's hold takes its step's
  category, because an edit changes a step's model and params and never its kind, so the step's category is fixed for the plan's life.
- An output stored before the migration has no category. Its plan has no category budgets, so no check reads it.
- The planning call is not in any category. It is the orchestrator's own call, held against the total as before.
- A plan past a category's allowance is still a plan. The run pauses at the step that would pass it, as it does for the total. The total
  is checked first, so a step that passes both reports the total.

## D10. The model brief is a reference the repository holds; the candidates are priced-only

- The model brief (`src/engine/prompts/model_brief@1.md`) is read as reference text in the plan's user message, not in the system prompt.
  Its id is named in that text, so each call says which brief it read. This file does not use D9, which the 2026-10-22 run uses for another decision.
- A candidate is a model the engine can price for its kind (`hasPriceBasis` in `validate.ts`: per token for text and speech, per image,
  per second at 1080p for video). A model the listing does not price is not offered, because a step that uses it is refused.
- A quality note is a dated, named source or the word unverified. Sourced rows come first in each class, then the rest newest first. The
  sources are marked secondary or vendor claim where they are.
- The planning hold counts the brief's size (`planInputTokensOf`), because the brief is sent with every plan call.
- Not decided here, for the owner: the engine reads only a per-second USD price at 1080p (`duration_seconds_1080p`). Most of the newest
  video models are priced in cents, per token, per generation or at another resolution, so they are not usable. Mapping those price forms
  changes what the engine prices, so it is the owner's call.

## D11. An approval raises both budgets; the run is started again by hand

- An approval sets the budget the user set and the plan's own budget to the approved amount. The run's target is the lower of the two
  (`envelope.ts`), so raising one alone would change nothing. The approval is refused unless the plan is paused for an approval and the
  amount is above the budget the plan has now. Only a workspace admin approves; the server function checks the role.
- An approval spends nothing. The user starts the run again. The screen shows the reason of the last pause, in the run's own words.
- The policy's initial values are read from the engine (`INITIAL_POLICY`), not typed into the screen.
- Not built, and the owner's to decide: a brand-level policy. The direction names a brand; the stored policy is per workspace, keyed by the
  organization. Precedence between a brand and its workspace needs a decision.
- Not built at the time: an audit row for each approval. The approval changes the plan's `updated_at` and its budgets only. D13 builds
  the audit row; where approvals are logged was the owner's decision, and it is now recorded there.

## D12. The budget is a line, not a tolerance (owner direction 2026-10-23; supersedes D2)

- A budget is a line. There is no percentage, no cents and no tolerance anywhere in the engine or on the screens.
- A paid step may start only while the committed spend is below its budget. Committed spend is the settled cost of the finished steps,
  plus the holds of calls in flight or queued, plus the holds of paid calls that failed. A failed call's hold counts as spent: fail closed.
- A call already in flight when the line is crossed finishes. Its cost may take the spend past the line; the overshoot is recorded, never
  hidden. No new paid step starts after the line.
- When the line is reached before the project is finished, the project pauses with the reason "budget reached, project not finished"
  (for a category: "<category> budget reached, project not finished"). The pause is an event of the plan. Every viewer sees the reason;
  the approval control is shown to admins only.
- The planning call is a paid call and follows the same rule. Nothing is committed at planning time, so it starts.
- A plan whose estimate is above the budget is accepted with a note that the run stops at the budget line. It is not refused.
- The brief path (`budget/reserve.ts`) follows the same rule. A call starts only while the committed amount of its request is below the
  request budget, and the committed amount of its workspace month is below the month budget. The reservation's allowance fields are no
  longer written; they stay optional for stored rows (a contract change, recorded in Bible section 4).
- A stored policy row may still carry `budgetTolerance`. It is read without that key, and nothing else in the row changes, so removing the
  key never resets the workspace's disabled model families.
- "The orchestrator is alerted" is read as the pause event and the orchestrator screen's alert. A new operations alert kind
  (`src/engine/ops/alerts.ts`) is not built; it can be added on the owner's word.
- Open for the owner: a single step whose estimate is larger than the remaining budget still starts while the line is not reached, so the
  overshoot can be that step's whole estimate. The stricter reading (start only if the estimate fits) is a one-line change.
- Open for the owner: two runs in one workspace can each start a call below the line at the same moment, so the overshoot can be one call
  per concurrent run.

## D13. Every budget approval is recorded (owner direction 2026-10-23; migration 0118)

- Migration 0118 adds `orchestrator_budget_approvals`: the plan, the actor, the previous budget, the approved budget, the pause reason at
  the time, and the time.
- The row is written in the same statement as the plan's budget update, so an approval without its record cannot happen.
- The plan shows its approvals, newest first.
- The brief path has no approval flow today. An approval added there is audited the same way.

## D14. A queued asset counts until it settles (fixes the queued-video gap; migration 0117)

- A video or avatar job the provider accepted is queued. Its hold is stored on its row (`orchestrator_asset_jobs.held_usd`, the row's total, and `hold_usd`, one submit), and
  committed spend includes the holds of waiting jobs in every later run of the plan, not only in the run that queued them.
- When the job settles, its output is charged its actual cost when the provider reports one, and its hold otherwise. The output replaces
  the hold, so nothing counts twice.
- When the job fails, its hold stays counted as a failed hold. Fail closed.
- A re-run while the job waits reports the step as queued and submits nothing. Before this change it failed the step with "already made".
- A waiting job with no recorded hold refuses the run until the poll settles it. Unknown is never zero.
- Before this change, a settled job whose provider reported no actual cost was stored with a null cost, and the spend counted it as zero.

## D15. Measure mode for unpriced video (owner direction 2026-10-23, for the first live test; migration 0117)

- An admin may start a run in measure mode. In measure mode a video or avatar step whose model has no engine price may run.
- Its hold is a per-second ceiling times its length in seconds (`params.seconds`). The ceiling is a workspace policy value,
  `measureCeilingUsdPerSecond`, with the initial value 0.50 USD per second, adjustable.
- The actual cost is the provider's reported bill (the ledger's reconciled cost). When none is reported, the hold is charged.
- The average cost per second is computed from reported actual costs only, stored in `orchestrator_cost_measurements` (migration 0117).
  It is shown. It never sets a hold: there is no prediction.
- Other steps without a price still fail closed. Cents-per-second prices stay deferred, as the owner said.

## D16. A brand's policy may only switch model families off (owner direction 2026-10-23; migration 0119)

- The workspace policy is the one global set: the disabled model families and the measure ceiling.
- A brand override adds families to the disabled set. A brand cannot switch on a family the workspace has switched off. The effective
  set is the union of the two.
- A plan records its brand (`orchestrator_plans.brand_id`). A plan with no brand uses the workspace set alone.
- Veo stays off by the initial value (D1), and no brand can turn it on.

## D17. A paid step starts only if its own hold fits the line (owner decision 2026-10-23; resolves the open question in D12)

- A paid step starts only while the committed spend is below its line and its own hold fits within it: committed spend plus the step's
  hold is not above the line. A step whose hold does not fit is refused before any request is made, and nothing is held for it.
- This applies to the request line, the workspace month line and a category line. A call at the line is refused even with a zero estimate.
- The overshoot therefore comes only from two sources: a bill above its estimate, or two calls running at the same time. Both are recorded.
- A run stops before the first step that does not fit. The pause reads "budget reached, project not finished: the next step's hold of $H
  would take the spend past the $L budget (committed $S)". Steps before it still run.
- The planning call follows the same rule: its hold must fit the budget, or the draft is refused before any call.
- A plan whose estimate is above its budget is still accepted with a note. The run stops at the first step that does not fit.
- Reservations are still accepted when they are above a budget, with a note. The calls are what the line gates.

## D18. Choices made after the independent reviews (the lead's choices; to be confirmed by the owner)

- An approval at a category pause (copy, creative or voice) raises that category's line in the stored brief, in the same statement as the plan update and the audit row. The audit reason records the category. An approval does not clear a pause at the workspace month line: the month budget is set in settings, not on the plan, and the alert says so.
- A stored orchestrator policy that does not parse refuses planning, runs, edits and the model list, with the reason to save the policy again. No family is reset or switched on by a malformed row.
- A plan run excludes the switched-off families on every route it builds, the fallbacks included. The first-and-last-frame route requires the families a run passes. A settle-time fallback or a retry rechecks them. An in-flight poll or settle is never refused for this.
- A failed queued job is charged its hold, and a re-run does not resubmit it. A retry the router refuses because its run has ended closes the job as failed, with the reason that a retry needs a new run.
- A measured clip's ledger hold is the plan's measure hold. A route with no listed price is kept for a measured clip, so measure mode can reach an unpriced video.
- Open for the owner: the retry after a settle conflict, which closes the job as failed and drops the other settle's bill; the consolidated CLAUDE.md question; and the default-off model family (D1) against main's operating brief (owner item 4 in RUN_STATE).
