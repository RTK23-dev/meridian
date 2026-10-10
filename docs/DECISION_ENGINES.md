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
- `decisions/gate.ts`: `runEngineGate`, the one path for production decisions that need contextual judgment (below).
- `decisions/policy.ts`: the shared policy. It reads normalized answers only, so it is the same for every engine. Each question is evaluated under its own versioned policy, taken from its registry `policyMapping`.
- `decisions/frames.ts`: representative frame selection for image judgments on video.
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

## The engine gate

`runEngineGate` (`decisions/gate.ts`) is how a production decision gets judgment from the active engine. It runs in this order:

1. **Deterministic rejections first.** Budget, source permission, media integrity, schema, provider capability, and rights are checked by code. If one fails, the gate rejects and no engine is called. An engine cannot override it.
2. **One selection, one call.** The active engine is resolved once, and one call to it carries every answerable question. There is no fallback to the other engine and no second opinion from it.
3. **Images are refused locally, never rerouted.** A question that needs an image is `unsupported` when JEV is active, and `abstain_insufficient_evidence` when no image was supplied. Neither is sent to the other engine.
4. **Policy per question.** Each gating question is evaluated under its own policy (`policyForQuestion`). The most severe outcome wins. A refused, unsupported, malformed, or missing answer, or a provider failure, resolves to the question's `unresolvedOutcome`, which is `HUMAN_REVIEW` unless the question says otherwise. A thrown engine error is a provider failure, so the gate fails closed.
5. **Persistence.** The gate writes `decision_gate_records` (migration `0048`): the engine, requested and returned model, question and policy versions, the evidence names and image hashes and timestamps that were provided, votes, unresolved answers, action, reason, latency, usage, and failure kind. The engine run is written to `jev_runs` and `jev_answers`, linked by `run_id`. Image bytes are never recorded.

Analysis questions (`gating: false`) are answered and recorded, but they do not decide the action. A gate with no gating question cannot approve anything, so it goes to review, and its reason says so.

## Production gates that use the engine

| Gate | Entry point | Asked of the engine | Stays local (deterministic) |
|---|---|---|---|
| Creative QA, images and video | `studio/image-qc.server.ts` `writeJudgment` | Text: `creative.brand_fit.v1`, `creative.opportunity_fit.v1`, `creative.claim_compliance.v1`. Image: `creative.visual_quality.v1`, `creative.product_visible.v1`. | A literal prohibited claim, an avoided word, product-name presence, measured logo and palette, competitor copy overlap, duplicates, novelty, and publishing readiness. A local REJECT is final and the engine is not called. |
| Brief | `studio/brief-gate.server.ts` `judgeBriefFit` | `brief.brand_fit.v1`, `brief.opportunity_fit.v1`, `brief.claim_compliance.v1`. | Mandatory fields present (audience, hook, message, angle) and no stored prohibited claim in the brief text. A failure rejects with no engine call. |
| Research evidence | `jev/service.ts` `evaluateEvidence` | Gating: `safety.*` (claim compliance and rights). The organic questions are analysis only. | Nothing in the gate. |

The lexical checks that were the previous semantic authority (token overlap for brand fit, and an angle-present check for opportunity) are no longer written as decisions (`ENGINE_REPLACED_MEDIA_QUESTIONS` in `studio/features.ts`).

**Behaviour changes to know about.**

- Under the default engine, JEV, the two visual questions are `unsupported`, so every generated image routes to human review. Before this change, the local model could approve an image without looking at it. Selecting `openai-decisions` in the JEV tab lets the visual questions run, with the image sent. A workspace that stays on JEV sees its generated images in review until a visual check is available to it.
- The brief's completeness check was a logistic prior, and it never rejected an empty brief. It is replaced by mechanical rules: the mandatory fields must be present, and a stored prohibited claim in the brief text rejects. Brand fit, opportunity fit, and claim compliance are the engine's. A brief the engine cannot judge goes to human review, and creating the brief is the user's explicit approval.

Generated images reach the engine as their verified stored bytes. Competitor copy and the generation prompt are never sent.

## Frames

For a video judgment, frames are sampled from the stored container with ffmpeg (`video/sample-frames.ts`). Eight evenly spaced timestamps run from the opening frame toward the end, with a 250 ms margin before the end, since a seek into the final frames often finds nothing. Each frame is recorded with the time ffmpeg sought to, and that time is the recorded timestamp. A timestamp is never estimated. A frame that fails to extract, or is not a PNG, is a recorded failure and is never replaced.

`decisions/frames.ts` then picks at most four frames: the **hook** (earliest), the **middle** beat, a **proof** frame (the one with the most on-screen text observed by OCR; no text, no proof frame), and the **call to action** (latest).

Sampling runs only when the active engine is `openai-decisions`. JEV cannot see images, so nothing is sampled for it. The gate context records how the frames were chosen: how many were sampled, provided, and omitted, by reason, and why sampling did not run if it did not (`engine_cannot_see_images`, `no_stored_container`, `no_duration`, `ffmpeg_unavailable`). The record names each frame with its timestamp and hash.

ffmpeg must be installed where the creative judgment runs (`FFMPEG_PATH`, or `ffmpeg` on the path). Without it, no frame is sent and the record says `ffmpeg_unavailable`.

## Status of each part

Implemented and covered by tests that run on PGlite:

- The shared domain, the dispatcher, selection precedence, and lineage persistence (`dispatch.test.ts`).
- The engine gate: deterministic-first, one engine call, local refusal of image questions, per-question policies, unresolved outcomes, analysis questions, provider failures, a thrown engine error, persistence, and no fallback or double execution (`gate.test.ts`, 21 tests, both selections).
- The creative gate and its image evidence, including a rejection from the engine, a deterministic rejection that stops the engine, and frame omission (`studio/creative-gate.test.ts`).
- Representative frame selection, including missing timestamps, duplicates, determinism, and the four-frame limit (`decisions/frames.test.ts`).
- ffmpeg frame sampling: real timestamps, recorded failures, unavailable reasons, cleanup, and one test on a real clip that is skipped with its reason when ffmpeg is not installed (`video/sample-frames.test.ts`).
- The brief gate: both engine selections, deterministic rejections that stop the engine, a provider failure that is never approved or switched, a claim-policy rejection, and the stored decision read by the same gate that loads a brief (`studio/brief-gate.test.ts`).
- The OpenAI Decisions adapter against fixtures shaped like the documented contract (`openai-engine.test.ts`): request shape, typed questions, data-URL images, refusals, missing and malformed answers, retries, timeouts, unknown models, authentication errors without key leakage, usage, and returned model.
- The JEV adapter and cross-engine fixtures (`engines.contract.test.ts`): both engines answer the same question kinds with the same semantics, and the same fixture values produce the same policy outcome.
- The shared policy and its thresholds and version lineage (`policy.test.ts`).
- The control panel selector and its server functions. Selection is saved only for a READY engine, and only admins can change it.

Implemented but not verified against the live service:

- **OpenAI Decisions has not been called live.** No request has been sent to `api.openai.com` from this repository. The fixtures reflect the documented contract at the time of writing, and the public beta may change it. Verify with a credentialed run before relying on it. This applies to the visual judgments in particular.

Not implemented, or known to be incomplete:

- **Video visual judgment is only as available as ffmpeg.** The frames are sampled at real timestamps, but only where ffmpeg is installed and only under OpenAI Decisions. Video creatives were already routed to review, so their status is unchanged.
- **Perception is not wired into JEV.** The perception contract (`perception/types.ts`) and its Gemini implementation exist, but production never calls them. The Gemini implementation handles keyframes only; its still-image method is not implemented. So JEV's visual questions remain `unsupported`, and no perception observation reaches a decision. Wiring it means choosing which provider sees the frames, so it needs a decision rather than a default.
- **Plan fit** is not a gate. Only brief fit and creative QA use the engine.
- **Research outcome.** The research gate's action is computed and recorded, but nothing downstream acts on it yet. The research worker still discards the answers' outcome.
- **Calibration.** No calibration report exists for either engine. Every value is uncalibrated, and the policy thresholds are configuration, not measured error rates.
- **Engine-specific question sets.** The question sets are the registry's, plus the creative set above. No engine has its own.
- **Shadow evaluation.** The flag exists, but it only gates JEV's existing compare mode, and no shadow runner exists.
- **Local measured checks are heuristics, not semantic judgments.** `competitor_copy_risk`, `duplicate_risk`, `logo_match`, and `palette_match` are measured comparisons. They are kept as deterministic evidence, and nothing calls them a semantic judgment.
