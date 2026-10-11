# Decisions

A decision asks an engine a set of questions about a brief, a creative or an opportunity, then turns the answers into
AUTO_APPROVE, HUMAN_REVIEW or REJECT. The engine never decides the outcome by itself. The policy does.

## Engines

- **TypeSafe JEV** (`jev`). Calls the TypeSafe Direct endpoint with the workspace's key. Evidence is text only.
- **OpenAI Decisions** (`openai-decisions`). Calls the OpenAI API with the workspace's key. It accepts images, up to 128 per request,
  and answers in the same structured form. Its model is set with `OPENAI_DECISIONS_MODEL`.

Exactly one is active for a workspace. The choice is made in Settings → JEV. When a workspace has not chosen, the deployment's
`DECISION_ENGINE` applies, and then `jev`. An invalid `DECISION_ENGINE` value is reported, not guessed at. Switching is refused unless
the target engine reports ready, and a decision never falls back to the other engine (ARCHITECTURE_CONTRACTS.md, section 2).

Both engines return the same normalized answers: a probability for a yes/no question, a choice with its confidence, or a score.
An answer that does not fit its question is a provider error, never a coerced value.

## Questions, evidence and the gate

Each question names the evidence it needs (its evidence scope). A question whose evidence is missing is not asked, and it
abstains. The gate (`decisions/gate.ts`) checks the scope, asks the engine, normalizes the answers and applies the policy.

The policy (`decisions/policy.ts`) is versioned and supplied per question. A question with no policy goes to review. A probability or
score approves only with an explicit threshold, and categorical answers are decided by their listed values. The fail-closed rules are
in ARCHITECTURE_CONTRACTS.md, section 6.

## Calibration

No engine's numbers are calibrated yet. A probability or score is what the engine reported. Until a calibration report says otherwise
(`learning/calibration-gate.ts`), such a number can send an item to review, but it cannot approve or reject it automatically. The
Calibration screen shows the calibration state the server reports.

## Records

Each decision is stored with its engine, model, policy version, question versions, evidence, votes and unresolved answers, and the
brief or creative it judged. The lineage links a creative back to the decision that let it through.
