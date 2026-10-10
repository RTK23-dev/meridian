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
- The planner reads the stored brief decision through `studio/jev-context.ts`. The brief gate's row (`question_id` `brief.gate`, schema `brief-gate.v1`) maps as follows: `REJECT` blocks, `AUTO_APPROVE` admits, and `HUMAN_REVIEW` admits only when a person approved it. Any other row is not an admissible judgment. The contract is tested at this boundary (`studio/brief-gate.test.ts`), so a change to either side fails there.
- The brief's completeness check was a logistic prior, and it never rejected an empty brief. It is replaced by mechanical rules: the mandatory fields must be present, and a stored prohibited claim in the brief text rejects. Brand fit, opportunity fit, and claim compliance are the engine's. A brief the engine cannot judge goes to human review, and creating the brief is the user's explicit approval.

Generated images reach the engine as their verified stored bytes. Competitor copy and the generation prompt are never sent.

## Briefs the engine could not judge

A brief whose required question the engine could not answer waits in `awaiting_review`. The engine error, the unsupported result, the malformed answer, and the unresolved judgment all count. This is `HUMAN_REVIEW` with no reviewer, and it is not approved.

- **Creation approves nothing.** Creating a brief, saving it, and the original submit button record no review. The decision row is written with no reviewer. Accepting a direction no longer approves an existing brief's decision.
- **Planning and production refuse it.** `loadGatedJevDecision` requires an explicit approval for a `HUMAN_REVIEW` decision. The planner reads the same row through `studio/jev-context.ts`, and gets no admissible judgment until a review is recorded.
- **The review is separate and explicit.** `reviewStudioBrief` (`studio/brief-review-access.server.ts`) needs an admin or owner, an acknowledgement that the reviewer has read the failure, the unresolved questions and the evidence, and a reason of at least 20 characters. The reviewer's role is read from the brand membership on the server.
- **The reviewer is disclosed.** The panel on the Brief tab shows the decision, the engine, the failure kind, the reasons, the unresolved questions with their reasons, the evidence provided with its timestamps and hashes, and any earlier reviews.
- **The record is append-only.** `decision_reviews` keeps the reviewer, role, whether they were the creator, the action, the reason, and the original engine outcome as the reviewer saw it. Updates and deletes are refused by a trigger. The audit log also names the review (`brief.review`).
- **A review can release only a `HUMAN_REVIEW`.** A `REJECT` is final, and that includes every deterministic rejection (a missing mandatory field, a literal prohibited claim). No review can turn it into approval. No separate policy override exists in this change. If one is added, it needs its own authorised policy, not this button.
- **The creator may review.** With no independent reviewer, the creator can review their own brief. The record says so (`reviewer_is_creator`). The override is auditable instead of blocked.
- **Only one review counts.** The decision is claimed with a condition, so a second review is refused.

## Perception

Perception and judgment are separate layers. A perception provider extracts grounded observations from images and video frames. A DecisionEngine judges the evidence under Meridian's policy. A perception provider is never a decision engine, and no engine is ever used for perception.

- **Provider.** `PERCEPTION_PROVIDER` selects the provider, independently of `DECISION_ENGINE`. Unset selects Gemini (`gemini-2.5-flash` by default, `PERCEPTION_MODEL`). `none` turns it off. Any other value is refused, and the reason is recorded. Gemini uses the canonical key (`MERIDIAN_GEMINI_API_KEY`, or a documented alias). The key goes in a request header, never in the URL.
- **Interface.** `MultimodalPerceptionProvider.perceive` returns one of three outcomes: observed, failed (with a kind), or never called. Nothing is filled in to hide a gap. Gemini implements still images and video frames through the same path.
- **Observations.** Each observation is attached to the media at its index, and carries that media's id, hash, and real timestamp (none for a still). Each is marked `basis: model_description`. These are the model's descriptions, not measurements. A missing, repeated or out-of-range observation is a failure, and nothing is attached. There is no invented end time and no invented quality score.
- **Validation.** Every item is checked by its own bytes before anything is sent: format (PNG, JPEG, WebP or GIF), size (20 MB per item, 48 MB in total), and hash. One invalid item fails the whole run.
- **Bounded.** At most four items per call. A video is judged on at most four frames, and its coverage says how many were analysed.
- **Reuse.** An identical earlier observed run (same media hashes and timestamps, same provider, model and prompt version, same kind) is reused. The provider is not called a second time.
- **Record.** Every run writes `perception_runs`: the media with its hashes, byte lengths and real timestamps; the provider, model and prompt version; the observations; the coverage; the latency and usage; and any failure kind. A run that never reached the provider is recorded too, with its reason.
- **Private media.** Media is read from Meridian's own storage and sent inline. No URL is made public to send it.

### Routing

| Engine selected | Media | What happens |
|---|---|---|
| `openai-decisions` | Images, or up to four sampled frames | Sent directly to OpenAI Decisions with their timestamps. Perception is not called, so the same frames are not analysed twice. |
| `jev` | Images, or up to four sampled frames | Perception runs once. Its grounded text (with timestamps, hashes, model and prompt version, and the coverage) goes to JEV. No image is sent to JEV. |
| `jev`, perception unavailable or failed | Any | Nothing is sent to OpenAI. The visual questions go to review. The text questions are still judged by JEV, and the failure is shown in the gate record. |

Under JEV, the two visual creative questions (`visual_quality`, `product_visible`) are `unsupported`. Perception describes what is visible, but it cannot stand in for a judgment of visual quality or of how clearly a product is shown, so those questions go to review. Perception feeds the text questions, for example on-screen claims that the copy alone would not show.

A video is never described as inspected in full. Each judgment records how many sampled frames were offered and how many were analysed.

## Frames

For a video judgment, frames are sampled from the stored container with ffmpeg (`video/sample-frames.ts`). They are sampled only when the engine takes frames (OpenAI Decisions), or when perception is ready to read them (JEV). Otherwise nothing is sampled, and the record says so. Eight evenly spaced timestamps run from the opening frame toward the end, with a 250 ms margin before the end, since a seek into the final frames often finds nothing. Each frame is recorded with the time ffmpeg sought to, and that time is the recorded timestamp. A timestamp is never estimated. A frame that fails to extract, or is not a PNG, is a recorded failure and is never replaced.

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
- The brief review: an engine failure, an unsupported result, or an unresolved judgment holds the brief; creation approves nothing; planning and production refuse it; the explicit review needs an admin, an acknowledgement and a reason; a rejection is final; the creator's self-review is recorded; the record is append-only (`studio/brief-review.test.ts`, 11 tests). The product-loop e2e performs the review.
- Perception: the Gemini provider's responses, failures and validation, with stubbed responses (`perception/multimodal.test.ts`, 9 tests); the runner's recording, reuse, bound and refusals against the database (`perception/run.test.ts`, 9 tests); and the creative routing, where OpenAI never triggers perception and JEV reads its grounded text (`studio/creative-gate.test.ts`).
- The brief gate: both engine selections, deterministic rejections that stop the engine, a provider failure that is never approved or switched, a claim-policy rejection, and the stored decision read by the same gate that loads a brief (`studio/brief-gate.test.ts`).
- The OpenAI Decisions adapter against fixtures shaped like the documented contract (`openai-engine.test.ts`): request shape, typed questions, data-URL images, refusals, missing and malformed answers, retries, timeouts, unknown models, authentication errors without key leakage, usage, and returned model.
- The JEV adapter and cross-engine fixtures (`engines.contract.test.ts`): both engines answer the same question kinds with the same semantics, and the same fixture values produce the same policy outcome.
- The shared policy and its thresholds and version lineage (`policy.test.ts`).
- The control panel selector and its server functions. Selection is saved only for a READY engine, and only admins can change it.

Implemented but not verified against the live service:

- **OpenAI Decisions has not been called live.** No request has been sent to `api.openai.com` from this repository. The fixtures reflect the documented contract at the time of writing, and the public beta may change it. Verify with a credentialed run before relying on it. This applies to the visual judgments in particular.

Not implemented, or known to be incomplete:

- **Video visual judgment needs ffmpeg and a frame reader.** Frames are sampled at real timestamps only where ffmpeg is installed, and only for OpenAI Decisions or for JEV with ready perception. Video creatives were already routed to review, so their status is unchanged.
- **Perception is wired for JEV and for OpenAI routing, but has not been run against Gemini.** The Gemini provider is tested with stubbed responses only. Its real responses, its real limits and its real behaviour on frames are unverified.
- **Workspace-vault perception credentials are not used.** The perception provider reads only the deployment's canonical Gemini key. The settings panel reports the same.
- **Plan fit** is not a gate. Only brief fit and creative QA use the engine.
- **Research outcome.** The research gate's action is computed and recorded, but nothing downstream acts on it yet. The research worker still discards the answers' outcome.
- **Calibration.** No calibration report exists for either engine. Every value is uncalibrated, and the policy thresholds are configuration, not measured error rates.
- **Engine-specific question sets.** The question sets are the registry's, plus the creative set above. No engine has its own.
- **Shadow evaluation.** The flag exists, but it only gates JEV's existing compare mode, and no shadow runner exists.
- **Local measured checks are heuristics, not semantic judgments.** `competitor_copy_risk`, `duplicate_risk`, `logo_match`, and `palette_match` are measured comparisons. They are kept as deterministic evidence, and nothing calls them a semantic judgment.
