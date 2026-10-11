# Architecture contracts

This document freezes the shared interfaces and rules for decisions, credentials, brief creation, and transactions. Each
workstream implements against these rules. No workstream redesigns them. A change to a contract is a coordinator decision,
recorded here first, before any code that depends on it.

Frozen code: `src/lib/db.ts` (`Sql.begin`, `createPoolSql`), `src/lib/meridian/learning/store.ts` (`withTransaction`),
`src/lib/meridian/credentials/contract.ts`, `src/lib/meridian/studio/brief-service.contract.ts`,
`src/lib/meridian/decisions/gate.ts` (`GateQuestion.evidenceScope`), `migrations/0051_decision_integrity.sql`.

## 0. Principles that apply to every contract

- **Fail closed.** A missing credential, a missing policy, a missing threshold, unsupported evidence, or an unresolved
  answer produces human review or refusal. It never produces approval.
- **One engine per decision.** The active engine (`DECISION_ENGINE`, or the workspace selection) is the only engine
  called. A refusal or failure is never retried against the other engine.
- **Unknown stays unknown.** A fact that a provider did not report is `null`. It is never recorded as a negative.
- **Real transactions only.** A write that must stay consistent across several rows runs in `withTransaction`. A
  compensating write (write, then undo on failure) is not used, because the undo can fail too.
- **Tenant scope on every read and write.** Every query filters by `organization_id`, and by `brand_id` where the row has one.

## 1. Credentials

One resolver: `credentials/resolve.ts` (`resolveCredential(sql, organizationId, category, env)`), returning a
`CredentialResolution` from `credentials/contract.ts`. Runtime execution, the readiness check, the settings summary and
Test Connection all call it. No other code reads a provider key from the vault or from the environment.

Rules, in order:

1. **Workspace first.** The workspace's saved entry (`CREDENTIAL_VAULT_TYPE[category]`, read for this organization only)
   is used when it is usable.
2. **A saved entry that cannot be used fails closed.** An expired entry, an unreadable entry, or an entry with no key is
   `unusable`. The resolver never returns the deployment key in its place.
3. **The deployment key is a shared default, and only when opted in.** With no saved entry, the deployment key is used only
   when `SHARED_DEFAULT_ENV[category].variable` is set to its accepted value. Otherwise the result is `not_configured`.
4. **Secrets stay in the caller.** `secret` goes only to the provider request. Settings, errors, logs, run records and audit
   metadata carry at most the masked fingerprint (`credentialFingerprint`: the last four characters, only for keys of eight
   characters or more).
5. **Test Connection checks the same resolution.** It reports `READY` only for a `usable` state. It says whether the live
   provider was called. Perception's check does not call Gemini.

Per category:

| Category | Saved key used for | Deployment key | Behaviour change |
|---|---|---|---|
| `perception` | Gemini perception (`PERCEPTION_PROVIDER`) | `PERCEPTION_SHARED_DEFAULT=gemini` | None. Already the rule. |
| `jev` | The TypeSafe JEV transport, per request, from `DecisionRequest.organizationId` | `JEV_SHARED_DEFAULT=deployment` | Deployment JEV keys are no longer used without the flag. OpenRouter stays deployment-only, and the panel says so. |
| `production` | Gemini Omni video and the Google image provider, through `CreativeSpec.organizationId` | `PRODUCTION_SHARED_DEFAULT=deployment` | Deployment production keys are no longer used without the flag. |

Operators who want the old behaviour set `JEV_SHARED_DEFAULT=deployment` and `PRODUCTION_SHARED_DEFAULT=deployment`.

## 2. Question-specific evidence

Each gate question declares the evidence it may receive: `GateQuestion.evidenceScope`, a list of `GateEvidence.name`
values (`decisions/gate.ts`). The rules:

- A question sees only the evidence in its scope. Its `state.availableEvidence` and its `state` contain only that evidence.
- Questions with the same scope share one engine call. Each group is one call to the active engine. The gate record keeps
  every group's request summary (scope names and model) and merges the answers.
- A question with no scope receives no evidence. It can be answered only if it needs none, and otherwise it abstains with
  `abstain_insufficient_evidence`.
- Perception observations are one evidence item, `perception_observations`. It is placed in the scope of only those
  questions whose evidence contract is fully satisfied, checked per question (`perception/contracts.ts`).
- Images are placed in the scope of the image questions only.
- Evidence supplied for one question never satisfies another question's requirement.

## 3. Brief creation

`createGatedBrief(sql, input)` in `studio/brief-service.server.ts` (`brief-service.contract.ts`). Every path that creates a
brief calls it. Today those are `openStudioBrief` (session) and `createBriefFromOpportunity` (creative actions).

Order, which is fixed:

1. Reserve the brief id.
2. Run `input.judge(briefId)`, the shared brief gate (`judgeBriefFit`). This is the engine call. No transaction is open.
3. In one `withTransaction`: write the decision and its gate record (`writeBriefDecision`, which takes the transaction),
   insert the brief with `briefStatusFor(action)`, and mark the opportunity `briefed` only if the brief is not rejected.

No path writes a brief row with status `ready` except through step 3 with an `AUTO_APPROVE` action. A brief created from an
opportunity goes through the same gate as a brief created from the studio.

Production refuses any brief whose status is not `ready` or `used` (`productionRefusalFor`, `studio/brief-review.server.ts`).

## 4. Brief review

`reviewBrief` runs entirely inside `withTransaction`: claim the decision (a conditional update that succeeds only for an
unreviewed row), move the brief (a conditional update that succeeds only from `awaiting_review`), insert the append-only
`decision_reviews` row, and insert the `audit_log` row. Any failure rolls back all four. The claim-then-revert code is
removed. A brief whose engine record is missing cannot be reviewed.

## 5. Opportunity-direction decisions

`recordOpportunityDirection(sql, input: OpportunityDirectionInput)`. It writes the append-only
`opportunity_direction_decisions` row (migration 0051), updates the opportunity's `reviews` row, and writes an `audit_log`
row, all in one `withTransaction`. It requires a reason of at least `MIN_DIRECTION_REASON_LENGTH` characters after trimming.

Selecting a direction never writes a brief decision, never sets `reviewer_decision` on a `jev_decisions` row, and never implies
that a brief passed its gate.

## 6. Policy defaults

Owned by `decisions/policy.ts` and `decisions/gate.ts`:

- A question with no policy mapping, or with no policy, produces `HUMAN_REVIEW`.
- A probability question with no `approveMinProbability` cannot approve. A score question with no `approveMinScore` cannot
  approve. A choice question with no approve values cannot approve. Each produces `HUMAN_REVIEW`.
- A probability or score vote whose `calibrationStatus` is not `calibrated` produces at most `HUMAN_REVIEW`. It never produces
  `AUTO_APPROVE` or `REJECT`. An uncalibrated confidence is never read as a calibrated probability.
- Categorical votes keep their explicit rules (`approveValues`, `rejectionValues`), because they are answers, not probabilities.
- `AUTO_APPROVE` requires an explicit versioned policy for every gating question, every scope present, and no unresolved
  gating answer.
- Missing, abstained, unsupported, malformed, or failed answers take the question's `unresolvedOutcome`, which is
  `HUMAN_REVIEW` unless a safety policy says `REJECT`.
- Deterministic rejections (missing mandatory brief fields, literal prohibited claims) run before any engine call and are final.

Product impact, stated plainly: until a calibration report exists, probability and score answers cannot auto-approve. Only
explicit categorical approvals can. Briefs and creatives that relied on uncalibrated probabilities now go to review.

## 7. Transactions

- `Sql.begin` (`db.ts`) runs a block in one real transaction on one connection. It is implemented on PGlite
  (`pg.transaction`) and on node-postgres (a pinned client with BEGIN, COMMIT, and ROLLBACK). A nested `begin` joins the
  outer transaction.
- `withTransaction(sql, fn)` (`learning/store.ts`) is the only way code uses a transaction. It throws when the connection
  cannot provide one.
- A connection whose ROLLBACK fails is discarded, not returned to the pool.
- Verified by `src/lib/db-transaction.test.ts` on PGlite, and on PostgreSQL when `MERIDIAN_PG_TEST_URL` is set.

## 8. Ownership

| Workstream | Owns | Must not change |
|---|---|---|
| Coordinator (frozen) | The files listed at the top, and migrations | Everything else, after the freeze |
| A: credentials | `credentials/resolve.ts`, `perception/credential.ts`, `perception/run.ts` (readiness), `jev/router.ts`, `jev/client.ts`, `decisions/jev-engine.ts` (key pass-through only), `production/providers/omni.ts`, `production/image-providers.ts`, `providers/nano-banana.server.ts`, `settings/provider-config.ts`, `settings/server-actions.ts`, `components/provider-settings-panel.tsx`, and their tests | Decision gate, policy, briefs, review |
| B: briefs and review | `studio/brief-service.server.ts` (new), `studio/brief-review.server.ts`, `studio/brief-review-access.server.ts`, `studio/creative-actions.ts` (`createBriefFromOpportunity` only), `studio/session.server.ts` (`openStudioBrief` and direction), `opportunity/actions.ts`, the studio UI for the direction reason, `scripts/product-loop.mjs` (direction step), and their tests | Gate, policy, evidence scopes, credentials |
| C: evidence and policy | `decisions/gate.ts`, `decisions/policy.ts`, `jev/questions/*.ts` (scopes), `studio/brief-gate.server.ts`, `studio/image-qc.server.ts`, `perception/contracts.ts`, and their tests | Credentials, brief creation, review |

Shared files: `session.server.ts` is B's. C changes only the functions it calls. `brief-gate.server.ts` is C's. B calls
`writeBriefDecision` inside a transaction with its signature unchanged.

## 9. Test databases

Each workstream migrates its own database: `meridian_ws_a`, `meridian_ws_b`, `meridian_ws_c`, with
`MERIDIAN_PG_TEST_URL=postgresql://postgres@localhost:5432/<name>?host=/var/tmp/meridian-pg`. The coordinator uses
`meridian_pg_test` for the final run. No two agents share a database.
