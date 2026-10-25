# OpenRouter in Meridian

OpenRouter is used for five different jobs. They have different endpoints, different keys and different readiness rules, and they are not interchangeable. This page is the inventory: each place that talks to OpenRouter, what it calls, where its key comes from, and whether it is in use, deployment-only or a known overlap.

## The endpoints

| Endpoint | Used for | Key |
| --- | --- | --- |
| `POST https://openrouter.ai/api/alpha/decisions` | Structured decisions (the Decisions API). | Two paths, below. |
| `POST https://openrouter.ai/api/v1/chat/completions` | Ordinary chat. | `openrouter_chat` (deployment only). |
| `https://openrouter.ai/api/v1` (video, image and speech generation, through the engine gateway) | Generation: video, images, speech. | `openrouter`, resolved per workspace. |

A decision never goes to the chat endpoint, and a chat call never goes to the Decisions endpoint. A decision is never produced by asking a chat model for JSON.

## Three model classes

OpenRouter models are not interchangeable across Meridian. Each class has its own catalogue, endpoint and settings, and a model belongs to one class only.

| Class | Used for | Endpoint | Catalogue and settings |
| --- | --- | --- | --- |
| **Decision models** | Structured judgments: JEV and the Decisions engine. Typed questions, typed answers (`noul`, `choice`, `score`). Never a prompt, a brief or copy. | `POST https://openrouter.ai/api/alpha/decisions` | The live decisions catalogue, read without a key. Chosen per workspace (`decision_engine_openrouter_config`), with the JEV backend (`decision_engine_jev_config`). |
| **Prompt and text-generation models** | Plans, scripts, copy and other text, and ordinary chat. | `POST https://openrouter.ai/api/v1/chat/completions` (`providers/chat.server.ts`) | The workspace's own key, through the engine gateway. Each task's model is chosen per workspace in Settings and checked against the live text catalogue before each paid call. The deployment's `OPENROUTER_MODEL` serves a text task the workspace has not chosen for. See "Ordinary text generation". |
| **Media models** | Image, video, speech and other modality-specific output. | Each adapter's own endpoint, through the engine gateway (`src/engine/gateway/`), which is the only place that makes these calls. | Capability-gated per adapter. Prices come from the provider's reported cost, not an estimate. |

A decision never goes to the chat endpoint, a chat or media model is never sent to the Decisions endpoint, and a decision is never produced by asking a chat model for JSON.

## The keys

- **`openrouter`** is the workspace's own OpenRouter key. A workspace saves it in Settings, with its masked fingerprint, and removes it there. The deployment's key is used for a workspace only when `OPENROUTER_SHARED_DEFAULT=deployment` is set. The resolver (`credentials/resolve.ts`) applies this precedence for every caller: a usable workspace key, then the deployment key only when shared, otherwise not configured. No call is made without a key.
- **`openrouter_chat`** is the deployment's `OPENROUTER_API_KEY`. It is deployment-only: a workspace cannot save it, and it is used only when `OPENROUTER_SHARED_DEFAULT=deployment` is set. Ordinary generation (`providers/chat.server.ts`) reads it only when no workspace is in scope, through the same resolver, and no ordinary generation path runs without a workspace.

A workspace's key and model never reach another organization. Every lookup is scoped to the signed-in workspace.

## Ordinary text generation

Copy and scripts, research analysis, brand brain suggestions and Factory image labels go through `providers/chat.server.ts`. Each call goes through the engine gateway, which takes the workspace's own key from the credential resolver, as every other OpenRouter call does.

| Task | Model used | Notes |
| --- | --- | --- |
| Copy and scripts | The workspace's choice, else `OPENROUTER_MODEL` | The studio's creative script and copy |
| Research analysis | The workspace's choice, else `OPENROUTER_MODEL` | Transcript analysis of collected ads |
| Brand brain suggestions | The workspace's choice, else `OPENROUTER_MODEL` | Suggests fields from a stored page |
| Image understanding | The workspace's choice only | The model must take images. `OPENROUTER_MODEL` is never used |

- **Key.** A usable workspace key is used alone. An unusable saved key is never replaced by the deployment key. The deployment-only key is read only with `OPENROUTER_SHARED_DEFAULT=deployment`, and only when no workspace is in scope.
- **Choice.** A workspace chooses each task's model in Settings, under "Text and image models". The save reads the live catalogue again and stores only a pinned text model with stated prices. An alias, a decision model, a model without stated prices, a model the catalogue no longer lists, or a text-only model for image understanding is refused, and the stored choice is unchanged. Clearing a choice needs no catalogue.
- **Before every paid call.** The chosen model is checked against the live catalogue again. A model that is missing, unpriced or unsuitable is refused, and nothing is sent. An unreadable catalogue refuses the call.
- **Without a choice.** A text task uses `OPENROUTER_MODEL` if the deployment sets it, and the answer says the deployment's default was used. Image understanding has no default: Factory keyframes are not labelled until a workspace chooses a model that takes images.
- **Recording.** Each sent call writes a `model_runs` row with the model asked for (`model`), where that choice came from (`model_source`), the model OpenRouter reports as having answered (`returned_model`), the generation id (`generation_id`), latency, tokens, and the cost OpenRouter reported (`cost_usd`). A null cost means OpenRouter reported none; it is never estimated. A refused call sends nothing and writes no row.
- **Failures.** A failed call is reported with its status, for example `OpenRouter returned 500.`. The provider's response body is not echoed, and no key appears in any result or error.
- **Shape of the response.** The parser reads the top-level `id` and `model`, and `usage.cost` in USD, as OpenRouter's chat completions reference documents them. This is checked against the documentation, not against a live response.

## Decision models: the live catalogue

Decision models come from OpenRouter's live model catalogue, read without a key from `GET https://openrouter.ai/api/v1/models?output_modalities=decisions`. An entry is eligible for the Decisions endpoint only if its output modality is `decisions`. The catalogue does not say which question types a model answers, so Meridian also keeps a **profile** for each model it has verified against the vendor's documentation. A model with no profile is listed with its reason and is not offered.

| Rule | What it does |
| --- | --- |
| Aliases (`~…`) | Refused everywhere. An alias moves to new builds, so its pinned target is what can be chosen. |
| No usable input price | Excluded. The call's cost could not be bounded before it is sent. |
| No context length | Excluded, for the same reason. |
| No usable output price, or a priced output with no stated largest output | Excluded. A call's output cost could not be bounded before it is sent. |
| No verified profile | Listed under "Not offered", with the reason. Meridian does not infer a model's questions or inputs from its name. |
| Catalogue unavailable | No decision model is offered, and no decision is sent. A failed read is remembered for one minute. |

The profiles in code (`src/lib/meridian/decisions/decision-catalog.ts`) at 2026-10-25:

| Model | Answers | Takes | Basis |
| --- | --- | --- | --- |
| `typesafe/jev-1.14` | probability, choice, score | text, PNG/JPEG images | TypeSafe's documentation, as recorded. The catalogue agrees on modalities. |
| `typesafe/jev-1.13` | probability, choice, score | text only | TypeSafe's documentation, as recorded. **The catalogue now lists image input too.** Meridian keeps the stricter reading until a vendor source or a live check says otherwise. |

The other 25 decision models in the recorded catalogue (`nace-ai/…`, `perplexity/…`, `liquid/…`, `cloudflare/…` and others) are listed and not offered. Each needs a profile, and a profile needs evidence of which primitives it answers. None has been recorded.

## The per-call ceiling

Before a decision is sent, its cost is bounded from the request it would send, and the call is refused if that bound is above the deployment's limit, `OPENROUTER_DECISION_MAX_USD_PER_CALL` (default `0.05`). The bound is:

- **Input:** the request's UTF-8 byte count at the catalogued input price. A tokenizer produces at most one token per byte, so this is an upper bound on the input tokens. It is capped at the model's context length, because a model cannot bill more input than its context holds.
- **A call with an image:** the whole context at the input price. The catalogue does not say how many tokens an image takes, so an image call is bounded by the most it could be.
- **Output:** the model's largest output (`top_provider.max_completion_tokens`) at its output price. A model whose output is priced but whose largest output is not stated is not offered, because its output cost could not be bounded.

The limit is a set of documented units: USD per token from the catalogue, and tokens from the request. A set value that is not a positive number is refused, so a mistyped limit cannot allow more than it says. The bound is stored with the provider-reported cost, so the two can be compared. It is a reservation, not an estimate, and it is not a monthly budget: decision spend has no monthly limit yet. The settings screen shows the most any call to a model can cost, which is its whole-context figure.

## Every path

| Where | What it does | Classification | Key | State |
| --- | --- | --- | --- | --- |
| `src/lib/meridian/decisions/openrouter-engine.ts` | The OpenRouter Decisions engine (`openrouter-decisions`): one Decisions request per decision, typed answers read by question name. | **OpenRouter Decisions API, workspace-keyed engine.** | `openrouter`, per workspace | New in this change. Fixture-tested. Live call not yet recorded. |
| `src/lib/meridian/decisions/openrouter-settings.ts` | Stores the workspace's chosen decision model and the results of explicit connection checks. | Storage for the decisions engine. | none | New. Scoped per workspace. |
| `src/lib/meridian/decisions/jev-engine.ts`, `decisions/jev-backend.ts` | JEV. The workspace's JEV backend (migration 0133) chooses one service: TypeSafe System One directly (the default when no row exists), or the OpenRouter Decisions engine. Exactly one backend is called per decision, with no fallback. An unreadable setting makes no request. Image evidence reaches JEV only through OpenRouter, and only for a model whose verified profile lists image input (`typesafe/jev-1.14` today). The gate resolves that once per decision and passes it to the adapter (`capabilities.ts`). The regression test runs the real gate and dispatcher (`jev-openrouter-images.test.ts`). | **Decisions API, workspace-keyed, chosen per workspace.** | TypeSafe key for TypeSafe; `openrouter`, per workspace, for OpenRouter. | Fixture-tested through the real gate. No live call recorded. |
| `src/lib/meridian/jev/router.ts`, `jev/client.ts` | The TypeSafe provider (`api.typesafe.ai/v1/systemone`) and the shared JEV helpers: input hashing, evidence sufficiency, state minimization. The helpers make no network call. | TypeSafe transport and helpers. No OpenRouter call. | TypeSafe key, per workspace. | Existing. Comments corrected in this change: the router has no OpenRouter provider and no router modes. |
| `src/components/jev-backend-controls.tsx` | The JEV backend control in Settings: each backend's readiness and the switch. | UI for the JEV backend. Shows state only, never a key. | — | New. Checked in a browser at 360, 390 and 1440 px. |
| `src/lib/meridian/providers/chat.server.ts`, `providers/model-run.ts` | Ordinary text generation: copy, research analysis, brand brain suggestions and Factory image labels. Each call goes through the engine gateway, and each sent call writes a `model_runs` row (`model-run.ts`). | Prompt and text-generation (`chat/completions`). | `openrouter`, per workspace, through the resolver. The deployment key only with the opt-in and no workspace in scope, which no ordinary path uses. | Rewritten in this change; the five callers use it. Fixture-tested through the gateway, the resolver and a fake transport. No live call recorded. |
| `src/lib/meridian/settings/generation-models.ts`, `migrations/0134_generation_task_models.sql`, `migrations/0135_model_run_provenance.sql` | The workspace's model for each text task (`generation_task_models`, one row per workspace and task), the eligibility rules, and the provenance columns on `model_runs`. | Storage and rules. | Per workspace. | New in this change. Database tests on the embedded backend. |
| `src/components/generation-model-settings.tsx`, `lib/meridian/settings/server-actions.ts` (`getGenerationModels`, `getGenerationCatalogue`, `saveGenerationModelChoice`) | The Settings section "Text and image models": the choice per task, the live catalogue list, and the save and clear actions (admin only). | UI and server functions. | Shows masked state only. | New in this change. Rendered in a browser with no key (the not-connected state). The populated list has not been seen live. |
| `src/engine/gateway/openrouter.ts` | Video generation through OpenRouter's video API, with the reported USD cost per job. | Model/generation gateway call. | `openrouter`, per workspace (through the gateway, `gateway/meridian.ts`) | Existing, unchanged. The engine rule holds: no `fetch` outside `gateway/transport.ts`, and keys come from the resolver. |
| `src/engine/gateway/providers.ts` (`baseUrl https://openrouter.ai/api/v1`) | The provider table entry for the generation gateway. | Model/generation gateway. | as above | Existing. |
| `src/engine/assets/providers/openrouterImage.ts`, `openrouterSpeech.ts`, `openrouterVideo.ts` | Image, speech and video providers. They call the gateway and hold no key. | Model/generation gateway, capability-gated. | as above | Existing. Each is offered only where its capability is verified. |
| `src/engine/config/routes.ts`, `config/prices.ts`, `gateway/catalog.ts`, `assets/model-choice.ts`, `assets/video-profiles.ts`, `orchestrator/*`, `ops/batch.ts`, `claude/*` | Model choice, route and price configuration for generation and orchestration, and the orchestrator's model catalogue. | Model/generation configuration. Not decisioning. | as above | Existing. Priced from the provider's reported cost, not from an estimate. |
| `src/lib/meridian/credentials/contract.ts`, `credentials/resolve.ts`, `credentials/live-readiness.ts`, `settings/provider-config.ts`, `settings/server-actions.ts` | The credential contract, the resolver and Settings. `openrouter` and `openrouter_chat` are separate categories. | Credential contract. | — | Existing. The decisions engine reuses the `openrouter` category; no parallel key was added. |
| `src/components/openrouter-decision-controls.tsx`, `decision-engine-selector.tsx`, `setup/engine-choice.tsx` | The decision model field, the explicit connection test and the engine choice. | UI for the decisions engine. | Shows masked state only. | New. |
| `migrations/0132_openrouter_decisions.sql` | Widens the engine checks, adds the model and check tables, and provider identity on decision runs. | Schema for the decisions engine. | — | New. Forward only. Earlier migrations are unchanged. |
| `src/components/content-factory/orchestrator-*.tsx`, `src/lib/meridian/orchestrator/actions.ts`, `src/lib/meridian/factory/decode.ts`, `src/lib/meridian/embeddings/provider.ts` | Labels, model panels and decoding for the generation and orchestration paths. | UI and decoding. Not decisioning. | — | Existing. |

## Open decisions for the owner

1. **Deployment default for text tasks.** Ordinary generation now uses the workspace's own key and a model the workspace chooses for each task. `OPENROUTER_MODEL` still serves a text task the workspace has not chosen for, and image understanding never uses it. Whether that default should exist at all is the owner's decision.
2. **Which model JEV uses through OpenRouter.** JEV through OpenRouter uses the workspace's OpenRouter decision model. Whether JEV should choose its own pinned model is a product decision.
3. **Image input for `typesafe/jev-1.13`.** The catalogue lists it with image input; the recorded documentation does not. The question is whether TypeSafe's documentation says so, or a live check confirms it. Until then it stays text-only.
4. **Image input for JEV at all.** JEV's input contract is text-only in its own documentation for the TypeSafe backend. Through OpenRouter, JEV receives image evidence only when the selected model's profile takes images, and only as image parts.

## Not built

These are deliberate gaps, not hidden ones. Each is stated in the product where it applies.

- **A reservation before each ordinary paid call, and a monthly limit for ordinary generation.** A call is made only with a model whose prices OpenRouter states, and its cost is recorded after it returns. No amount is reserved before the call, and no monthly limit applies. A failed analysis re-queues its research job (`retryCollection`), which makes another paid call. The rule that a billed request is never retried blindly is not met on this path yet: a call that OpenRouter billed and then failed can be paid for again. This is open.
- **Per-task choice for the orchestrator's media models.** The Settings section chooses one model per ordinary text task. Video, image and speech models stay on the orchestrator's own route configuration.
- **A monthly decision spend limit.** The per-call bound is the only limit.
- **Live verification of any model.** See below.

The status panel reports JEV's capabilities for the backend the workspace chose: text only through TypeSafe, and the chosen model's profile through OpenRouter.

## What was not verified

- **No live call has been made to OpenRouter in this change.** No OpenRouter key is available in this environment, so no paid request was sent. The catalogue read is public and was recorded (2026-10-25, 30 decision entries). Every other test uses a fixture or a fake fetch.
- **Live verification steps that remain for the owner:** (1) save a read-only OpenRouter key in Settings; (2) choose `typesafe/jev-1.14`; (3) run **Test the connection**, which sends one billable request; (4) confirm the returned model, the provider request id and the cost against the recorded `ceilingUsd` and `reportedCostUsd`; (5) for JEV over OpenRouter, run one decision with an image and confirm the lineage records the image as sent.
- The reported cost is stored as the provider reports it, and the ceiling is stored beside it. Meridian has no price table for this engine, so decision spend records the reported cost as reported, not as a price.
- The profile for each model is a claim about its documentation. No primitive of any model has been checked by a live request.
