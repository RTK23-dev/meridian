# Decision engines

Meridian makes typed decisions (is a claim supported, is a creative safe, which category fits) through one of two interchangeable decision engines:

- **TypeSafe JEV**, the existing integration (`src/lib/meridian/jev/`), kept unchanged in behaviour.
- **OpenAI Decisions**, the native `POST /v1/decisions` endpoint (`src/lib/meridian/decisions/openai-engine.ts`).

Meridian owns the decision semantics. Question definitions, evidence, policy, provenance, and the production workflow belong to Meridian. An engine is the component that evaluates one question, and it can be replaced without changing the rest of the system.

## Boundary

```
question registry (Meridian)  ->  evidence (Meridian)  ->  DecisionRequest
                                                              |
                          decideWithActiveEngine (dispatcher) |
                                                              v
                                       exactly one DecisionEngine: jev | openai-decisions
                                                              |
                                              DecisionResult (normalized)
                                                              |
                                    policy (Meridian, versioned)  ->  AUTO_APPROVE | HUMAN_REVIEW | REJECT
```

- `decisions/types.ts`: the provider-neutral domain. `DecisionEngine`, `DecisionRequest`, `DecisionResult`, and `DecisionCapabilities`. Provider request and response types never leave the adapters.
- `decisions/dispatcher.ts`: `decideWithActiveEngine`, the single entry point for production decisions. It resolves the active engine, calls that engine once, records the lineage, and returns the result. It never calls the other engine.
- `decisions/selection.ts`: the active-engine rule and the save path.
- `decisions/policy.ts`: the shared policy. It reads normalized answers only, so it is the same for every engine.
- `decisions/lineage.ts`: the decision ledger (`jev_runs`, `jev_answers`), with engine columns.

## Choosing the active engine

Precedence, highest first:

1. The workspace setting in `decision_engine_settings`, saved from the control panel (JEV tab, admin only). It is per organization.
2. The deployment default `DECISION_ENGINE` (`jev` or `openai-decisions`).
3. `jev`, which is the engine that ran before this change.

An invalid `DECISION_ENGINE` value is ignored, the default is used, and the control panel says so.

A switch is accepted only when the target engine reports `READY`. A refused switch keeps the previous selection and states the reason. Each accepted switch writes an audit record (`decision_engine.update`) with the previous and new engine. No credential is written to it.

## Failure behaviour

- **No silent fallback.** If the active engine fails, the decision carries that engine's failure. The other engine is not called. JEV's own transport fallback is separate and off by default (`MERIDIAN_JEV_FALLBACK_ENABLED=false`).
- **No duplicate decisions.** One request, one engine. Compare or shadow evaluation is not part of production dispatch. The `MERIDIAN_DECISION_SHADOW_ENABLED` flag only controls whether JEV's existing compare mode can run; it is off by default.
- **Bounded retries.** OpenAI Decisions retries rate limits and 5xx responses up to `OPENAI_DECISIONS_MAX_RETRIES` (default 1, capped at 3). A timeout is not retried, because the request may already have been processed and billed.
- **Fail closed.** A refusal, an unsupported question or input, a malformed response, a provider error, or a missing answer never becomes an approval. The policy resolves each with its `unresolvedOutcome`, which is `HUMAN_REVIEW` by default and `REJECT` for safety gates.

## Question types

| Registry type | Decision kind | OpenAI Decisions | JEV |
|---|---|---|---|
| `noul` | predicate: probability that a condition is true | `predicate` (`probability`) | yes |
| `choice` | one of a fixed set of values | `choice` (`choice`, `probabilities`, `confidence`) | yes |
| `score` | ordered levels | `score` (a probability-weighted level index) | yes |

Semantics, which are never converted:

- A predicate `probability` is a probability of the stated condition. It is not a calibrated Meridian probability.
- A `choice` is categorical. Its `confidence` is the provider's, not a calibrated posterior, so Meridian does not interpret it as one.
- A `score` is a level index. A weighted average can fall between levels, so it is reported as an ordered-level expectation.

Every answered value is marked `calibrationStatus: "uncalibrated"`. No value becomes calibrated without a calibration report in the learning layer.

## Answer states

| Status | Meaning | Carries a value |
|---|---|---|
| `answered` | a well-formed answer of the asked type | yes |
| `refused` | the provider refused this question | no |
| `unsupported` | the question or input cannot be expressed for this engine | no |
| `invalid_response` | a missing, mistyped, out-of-set, or out-of-range answer | no |
| `provider_error`, `not_configured` | the request did not produce answers | no |
| `abstain_insufficient_evidence` | required evidence is missing; nothing was sent for this question | no |

## Images

- **OpenAI Decisions** takes images as base64 data URLs in one user message, with text parts. Hosted URLs and file IDs are not sent, so private media is never made public to satisfy the API. Each image is checked by its own bytes: the format must be PNG, JPEG, WebP, or GIF, the size is capped per image (20 MB) and in total (48 MB), and at most 128 images are sent. An invalid set is refused before any request is made.
- **JEV** is text-only. A decision that requires images (`imagePolicy: "required"`) is refused as unsupported. With `imagePolicy: "optional"`, the decision proceeds on text, and the number of images not seen is recorded (`imagesOmitted`).
- Image bytes are never logged. Lineage records an image count and the input modality, not the content.

## Configuration

OpenAI Decisions:

```
OPENAI_API_KEY=...                 # required for openai-decisions
OPENAI_DECISIONS_MODEL=gpt-6-luna  # the documented model; configurable, not assumed to be the only one
OPENAI_DECISIONS_TIMEOUT_MS=60000
OPENAI_DECISIONS_MAX_RETRIES=1
```

The adapter sends `safety_identifier`, a one-way hash of the organization identifier, and never the identifier itself.

JEV: see [JEV.md](JEV.md). The transport and routing variables are unchanged. The default for `MERIDIAN_JEV_FALLBACK_ENABLED` changed from `true` to `false`.

Engine selection: `DECISION_ENGINE`, or the control panel's JEV tab.

Credentials stay on the server. The control panel shows configuration status and the names of missing settings, never a key.

## Versions recorded with each decision

| Version | Where |
|---|---|
| Question version | `jev_answers.question_version` (from the registry) |
| Engine adapter version | `jev_runs.adapter_version` (`openai-decisions-adapter.v1`, `jev-adapter.v1`) |
| Requested model and returned model | `jev_runs.requested_model`, `jev_runs.model` |
| Engine | `jev_runs.engine_id`, `jev_answers.engine_id` |
| Policy version | returned by `evaluateDecisionPolicy` (for example `creative-qa.v1`) |
| Usage and latency | `jev_runs.usage`, `jev_runs.latency_ms` |
| Failure | `jev_runs.failure_kind`, `jev_runs.status = 'failed'` |

Migration `0046_decision_engines.sql` adds `decision_engine_settings` and the engine columns. Rows written before it have no engine and were made by JEV.

## Status of each part

Implemented and covered by tests that run on PGlite:

- The shared domain, the dispatcher, selection precedence, and lineage persistence (`dispatch.test.ts`).
- The OpenAI Decisions adapter against fixtures shaped like the documented contract (`openai-engine.test.ts`): request shape, typed questions, data-URL images, refusals, missing and malformed answers, retries, timeouts, unknown models, authentication errors without key leakage, usage, and returned model.
- The JEV adapter and cross-engine fixtures (`engines.contract.test.ts`): both engines answer the same question kinds with the same semantics, and the same fixture values produce the same policy outcome.
- The shared policy and its thresholds and version lineage (`policy.test.ts`).
- The control panel selector and its server functions. Selection is saved only for a READY engine, and only admins can change it.

Implemented but not verified against the live service:

- The OpenAI Decisions adapter. No request has been sent to `api.openai.com` from this repository. The fixtures reflect the documented contract at the time of writing, and the public beta may change it. Verify with a credentialed run before relying on it.

Not implemented in this change:

- Engine-specific question sets beyond the existing registry. The registry's questions are used as they are.
- A calibration report for either engine. Every value is uncalibrated.
- Shadow evaluation. The flag exists, but it only gates JEV's existing compare mode, and no shadow runner exists.
- The existing gates in `jev/policy.ts` are not yet expressed through the new policy module. The new policy is available and tested, but the older gates still decide production outcomes.
