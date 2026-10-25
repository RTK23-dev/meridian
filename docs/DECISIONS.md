# Decisions

A decision asks an engine a set of questions about a brief, a creative or an opportunity, then turns the answers into
AUTO_APPROVE, HUMAN_REVIEW or REJECT. The engine never decides the outcome by itself. The policy does.

## Engines

- **TypeSafe JEV** (`jev`). JEV's questions and answer checks are fixed. The service that answers is the workspace's JEV backend: TypeSafe
  System One directly with the workspace's key (the default), or OpenRouter Decisions. See "JEV backend" below. Evidence is text only.
- **OpenAI Decisions** (`openai-decisions`). Calls the OpenAI API with the workspace's key. It accepts images, up to 128 per request,
  and answers in the same structured form. Its model is set with `OPENAI_DECISIONS_MODEL`.
- **OpenRouter Decisions** (`openrouter-decisions`). Calls OpenRouter's Decisions API (`POST https://openrouter.ai/api/alpha/decisions`) with the
  workspace's OpenRouter key. It is not a chat completion. Its model is a pinned, verified decision model: the workspace's own choice, then
  `OPENROUTER_DECISIONS_MODEL`, then `typesafe/jev-1.14`. See "OpenRouter Decisions" below.

Exactly one is active for a workspace. The choice is made on the Setup page (`/setup`). When a workspace has not chosen, the deployment's
`DECISION_ENGINE` applies, and then `jev`. An invalid `DECISION_ENGINE` value is reported, not guessed at. Switching is refused unless
the target engine reports ready, and a decision never falls back to the other engine (ARCHITECTURE_CONTRACTS.md, section 2).

Every engine returns the same normalized answers: a probability for a yes/no question, a choice with its confidence, or a score.
An answer that does not fit its question is a provider error, never a coerced value.

## Questions, evidence and the gate

Each question names the evidence it needs (its evidence scope). A question whose evidence is missing is not asked, and it
abstains. The gate (`decisions/gate.ts`) checks the scope, asks the engine, normalizes the answers and applies the policy.

The policy (`decisions/policy.ts`) is versioned and supplied per question. A question with no policy goes to review. A probability or
score approves only with an explicit threshold, and categorical answers are decided by their listed values. The fail-closed rules are
in ARCHITECTURE_CONTRACTS.md, section 6.

## Calibration

No engine's numbers are calibrated yet. A probability or score is what the engine reported. The calibration report
(`learning/calibration-report.ts`) says "not calibrated" until 200 usable outcomes exist, and shows no numbers before then. Until a
calibration report says otherwise (`learning/calibration-gate.ts`), such a number can send an item to review, but it cannot approve or
reject it automatically. The Calibration screen shows the calibration state the server reports.

## Records

Each decision is stored with its engine, model, policy version, question versions, evidence, votes and unresolved answers, and the
brief or creative it judged. The lineage links a creative back to the decision that let it through.

## OpenRouter Decisions

- **Request.** One Decisions request per decision: `model`, `state` and `questions`, each question keyed by a stable name. The answers come back keyed by the same names, so they are read by name, not by position. Meridian sends no chat prompt and never asks a chat model to write JSON.
- **Models.** The models offered are the decision models in OpenRouter's live catalogue (`GET /api/v1/models?output_modalities=decisions`, public, no key), that have a profile Meridian has verified: which questions the model answers, and which inputs it takes. Today that is `typesafe/jev-1.14` (text and PNG/JPEG images) and `typesafe/jev-1.13` (text only, although the catalogue now lists image input too). Every other decision model is listed with its reason and is not offered. Aliases (`~…`) are refused, and so is any model the catalogue does not list. A model's name never implies its inputs. See OPENROUTER.md, "Decision models: the live catalogue".
- **Key.** The workspace's saved OpenRouter key, the same credential the video engine uses. The deployment key is used only when `OPENROUTER_SHARED_DEFAULT=deployment` is set. With neither, the engine reports NOT_CONFIGURED and sends nothing.
- **Readiness.** CONFIGURED: the key and model are set, and no connection test has passed for them. READY: the latest connection test passed for the same model and the same key fingerprint. UNSUPPORTED: the model is invalid or not verified. A saved key alone is never READY, and a changed key or model makes an earlier pass stop counting.
- **Connection test.** An explicit admin action. It sends one real request with a fixed sentence and one yes-or-no question, and it may incur model usage. It changes no product data and no active engine. Its outcome is recorded in `decision_engine_checks`, with the masked key fingerprint and the model.
- **Failures.** Authentication, rate limit, timeout, network, provider error, unknown model, invalid request and invalid response are each reported as their own failure. A call is never retried, because a retried paid call could be billed twice, and no other engine, model or provider is tried.
- **Answers.** A missing, mistyped, contradictory or out-of-range answer is an invalid response. Nothing is coerced into an approval or a rejection. Probabilities are the provider's, and each is marked uncalibrated until the calibration gate establishes a calibration for the model, question and outcome.
- **Images.** A PNG or JPEG is sent as an image part, labelled as the evidence was labelled, only to a model whose profile takes images. A required image the model cannot take refuses the decision before any request. An optional one is left out, and the omission is recorded in the result and the lineage.
- **Cost.** The run keeps the cost OpenRouter reports for a call, when it reports one, and the upstream provider and the provider's request id. Meridian has no price for this engine, so decision spend records its cost as unknown, never as zero.
- **Ceiling.** Before a call, its most expensive case is computed: the model's whole context at its catalogued input price. A call whose ceiling is above `OPENROUTER_DECISION_MAX_USD_PER_CALL` (default $0.05) is refused with its numbers and nothing is sent. The ceiling is stored beside the reported cost. It is a per-call bound, not a monthly budget, and decision spend has no monthly limit yet.
- **Policy.** The engine is advisory. Policy, evidence sufficiency, rights, integrity and human review stay authoritative. An OpenRouter result never approves, publishes, renders or spends anything.

## JEV backend

JEV chooses its service per workspace, in Settings, under the decision engine.

- **Choices.** `typesafe_direct` (TypeSafe System One, with the workspace's TypeSafe key) and `openrouter` (OpenRouter Decisions, with the workspace's OpenRouter key and its decision model). A workspace with no saved choice uses `typesafe_direct`. The stored value is in `decision_engine_jev_config` (migration 0133). Any other value is refused, never guessed at.
- **One backend, no fallback.** A decision calls exactly one backend. If it fails, the failure is reported as that failure, and the other backend is not tried. A paid call is never repeated on another route.
- **Unreadable setting.** If the stored choice cannot be read, JEV makes no request to either backend and reports `not_configured` with the reason. Settings shows the choice as unknown, and does not show the default in its place.
- **Switching.** A switch is saved only when the target backend reports READY, and the server checks that again when saving. A refused switch keeps the stored backend and says why. The OpenRouter backend is READY only after a passed connection test for its model and key (see "OpenRouter Decisions").
- **Lineage.** A JEV decision through OpenRouter is recorded as a JEV decision (`engineId: jev`), with OpenRouter as the provider that served it, and the upstream provider and request id when OpenRouter reports them.
- **Images.** The gate resolves the backend and model once for each decision and passes them to the engine. JEV through TypeSafe takes text only, so no image is sent. JEV through OpenRouter takes an image only when the selected model's profile lists image input (`typesafe/jev-1.14` today), and then sends it as an image part. An unreadable backend or model sends no image, so a visual question goes to review rather than being judged without its image. Every image is checked for type and size before it is sent.
- **Readiness with no workspace.** Without a workspace, nothing is checked and nothing is READY.
