# Architecture contracts

These are the rules the code is built on. Comments in the code cite them by number, so the numbers are stable. A change to
one of these rules is a change to the product and needs a note in the CHANGELOG.

## 1. Credentials

1.1 A workspace's saved key is used first, and only for that workspace. No workspace can read another workspace's key, even
by its row id.

1.2 A saved key that cannot be used (expired, unreadable, empty) is reported as unusable. The deployment's key is never used
in its place.

1.3 The deployment's key is used only when that category's shared default is set to its accepted value (for example
`JEV_SHARED_DEFAULT=deployment`). Without the opt-in it is never used.

1.4 A key is never returned to a browser, written to a log, a run record or an audit row. Settings show a masked fingerprint.

1.5 One resolver, `src/lib/meridian/credentials/resolve.ts`, reads provider keys. Infrastructure secrets (listed in PROVIDERS.md)
are read from the environment by the code that owns them.

## 2. Decision engines

2.1 Exactly one decision engine is active for a workspace. Its choice is set in the workspace (Settings, JEV tab), or by the
deployment's `DECISION_ENGINE` when the workspace has not chosen one.

2.2 A decision never runs a second engine to compare, and never falls back to another engine when one fails.

2.3 Switching engines is refused unless the target engine reports ready. The previous valid choice is kept.

2.4 Engines are called with structured requests and answer in a structured form. No engine is asked to decide by prompting.

2.5 Every engine's answers are normalized before the policy sees them, so the policy is the same whichever engine answered.

## 3. Brief creation

3.1 Every brief is created through `createGatedBrief`. No other path writes a brief row.

3.2 The brief gate judges a brief first, and the row is written only after the judgement. A brief is `ready` only when the gate
approves it automatically. Otherwise it is `awaiting_review` or `rejected`.

3.3 A brief that is not `ready` is not generated from until a person accepts it.

## 4. Storage

4.1 Postgres is the system of record. Drive and S3 hold artifacts and exports, and a storage object row says where each one is.

4.2 An export package is a set of files, and Postgres rows list them. Drive is not used to store state.

4.3 An upload that is interrupted continues from the last byte the storage confirmed. Its session is kept in Postgres, and
the session holds no access token.

## 5. Generation and spend

5.1 A generation runs only from a `ready` brief.

5.2 Budget is reserved before a provider call and released when the call fails. Spend is recorded from the provider's result.

## 6. Decision policy

6.1 A question with no policy mapping goes to review, whatever its answer.

6.2 A refused, unsupported, malformed, unavailable or missing answer takes the policy's unresolved outcome.

6.3 A probability can approve only when the policy names `approveMinProbability`. A score can approve only when it names
`approveMinScore`. A choice can approve only when it names `approveValues`. Without these, the answer goes to review.

6.4 A probability or score that is not calibrated can route to review, and nothing else. It never produces AUTO_APPROVE or REJECT.
Confidence is never read as a probability.

6.5 A categorical answer is an answer, not a probability. Its explicit approve and reject values decide it.

## 7. Publishing and delivery

7.1 Nothing is reported as published unless a real connection returned a receipt for it.

7.2 Where live posting is not available, the manual export package is the way to deliver. The person posts the package by hand.

7.3 A channel with no connection says so, with the reason, and offers no action that would publish.

## 8. Telemetry and learning

8.1 Synthetic or simulated telemetry never enters learning. The learning code rejects it.

8.2 A metric is shown only when it was observed. No fixed number stands in for a missing one.
