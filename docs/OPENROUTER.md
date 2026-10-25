# OpenRouter in Meridian

OpenRouter is used for five different jobs. They have different endpoints, different keys and different readiness rules, and they are not interchangeable. This page is the inventory: each place that talks to OpenRouter, what it calls, where its key comes from, and whether it is in use, deployment-only or a known overlap.

## The endpoints

| Endpoint | Used for | Key |
| --- | --- | --- |
| `POST https://openrouter.ai/api/alpha/decisions` | Structured decisions (the Decisions API). | Two paths, below. |
| `POST https://openrouter.ai/api/v1/chat/completions` | Ordinary chat. | `openrouter_chat` (deployment only). |
| `https://openrouter.ai/api/v1` (video, image and speech generation, through the engine gateway) | Generation: video, images, speech. | `openrouter`, resolved per workspace. |

A decision never goes to the chat endpoint, and a chat call never goes to the Decisions endpoint. A decision is never produced by asking a chat model for JSON.

## The keys

- **`openrouter`** is the workspace's own OpenRouter key. A workspace saves it in Settings, with its masked fingerprint, and removes it there. The deployment's key is used for a workspace only when `OPENROUTER_SHARED_DEFAULT=deployment` is set. The resolver (`credentials/resolve.ts`) applies this precedence for every caller: a usable workspace key, then the deployment key only when shared, otherwise not configured. No call is made without a key.
- **`openrouter_chat`** is the deployment's `OPENROUTER_API_KEY`. It is deployment-only: a workspace cannot save it, and it is used only when `OPENROUTER_SHARED_DEFAULT=deployment` is set. Chat (`providers/chat.server.ts`) reads it through the same resolver.

A workspace's key and model never reach another organization. Every lookup is scoped to the signed-in workspace.

## Decision models: the live catalogue

Decision models come from OpenRouter's live model catalogue, read without a key from `GET https://openrouter.ai/api/v1/models?output_modalities=decisions`. An entry is eligible for the Decisions endpoint only if its output modality is `decisions`. The catalogue does not say which question types a model answers, so Meridian also keeps a **profile** for each model it has verified against the vendor's documentation. A model with no profile is listed with its reason and is not offered.

| Rule | What it does |
| --- | --- |
| Aliases (`~…`) | Refused everywhere. An alias moves to new builds, so its pinned target is what can be chosen. |
| No usable input price | Excluded. The call's cost could not be bounded before it is sent. |
| No context length | Excluded, for the same reason. |
| No verified profile | Listed under "Not offered", with the reason. Meridian does not infer a model's questions or inputs from its name. |
| Catalogue unavailable | No decision model is offered, and no decision is sent. A failed read is remembered for one minute. |

The profiles in code (`src/lib/meridian/decisions/decision-catalog.ts`) at 2026-10-25:

| Model | Answers | Takes | Basis |
| --- | --- | --- | --- |
| `typesafe/jev-1.14` | probability, choice, score | text, PNG/JPEG images | TypeSafe's documentation, as recorded. The catalogue agrees on modalities. |
| `typesafe/jev-1.13` | probability, choice, score | text only | TypeSafe's documentation, as recorded. **The catalogue now lists image input too.** Meridian keeps the stricter reading until a vendor source or a live check says otherwise. |

The other 25 decision models in the recorded catalogue (`nace-ai/…`, `perplexity/…`, `liquid/…`, `cloudflare/…` and others) are listed and not offered. Each needs a profile, and a profile needs evidence of which primitives it answers. None has been recorded.

## The per-call ceiling

Before a decision is sent, its most expensive case is computed: the model's whole context length at its catalogued input price. The call is refused if that ceiling is above the deployment's limit, `OPENROUTER_DECISION_MAX_USD_PER_CALL` (default `0.05`). A set value that is not a positive number is refused, so a mistyped limit cannot allow more than it says. The ceiling is stored with the provider-reported cost, so the two can be compared. It is a bound, not an estimate, and it is not a monthly budget: decision spend has no monthly limit yet.

## Every path

| Where | What it does | Classification | Key | State |
| --- | --- | --- | --- | --- |
| `src/lib/meridian/decisions/openrouter-engine.ts` | The OpenRouter Decisions engine (`openrouter-decisions`): one Decisions request per decision, typed answers read by question name. | **OpenRouter Decisions API, workspace-keyed engine.** | `openrouter`, per workspace | New in this change. Fixture-tested. Live call not yet recorded. |
| `src/lib/meridian/decisions/openrouter-settings.ts` | Stores the workspace's chosen decision model and the results of explicit connection checks. | Storage for the decisions engine. | none | New. Scoped per workspace. |
| `src/lib/meridian/decisions/jev-engine.ts`, `decisions/jev-backend.ts` | JEV. The workspace's JEV backend (migration 0133) chooses one service: TypeSafe System One directly (the default when no row exists), or the OpenRouter Decisions engine. Exactly one backend is called per decision, with no fallback. An unreadable setting makes no request. | **Decisions API, workspace-keyed, chosen per workspace.** | TypeSafe key for TypeSafe; `openrouter`, per workspace, for OpenRouter. | New in this change. Fixture-tested. No live call recorded. |
| `src/lib/meridian/jev/router.ts`, `jev/client.ts` | The TypeSafe provider (`api.typesafe.ai/v1/systemone`) and the shared JEV helpers: input hashing, evidence sufficiency, state minimization. The helpers make no network call. | TypeSafe transport and helpers. No OpenRouter call. | TypeSafe key, per workspace. | Existing. Comments corrected in this change: the router has no OpenRouter provider and no router modes. |
| `src/components/jev-backend-controls.tsx` | The JEV backend control in Settings: each backend's readiness and the switch. | UI for the JEV backend. Shows state only, never a key. | — | New. Checked in a browser at 360, 390 and 1440 px. |
| `src/lib/meridian/providers/chat.server.ts` | Ordinary chat (`openrouter`, `OPENROUTER_MODEL`). | Ordinary OpenRouter chat. | `openrouter_chat` (deployment only) | Existing, unchanged. It needs `OPENROUTER_SHARED_DEFAULT=deployment`. |
| `src/engine/gateway/openrouter.ts` | Video generation through OpenRouter's video API, with the reported USD cost per job. | Model/generation gateway call. | `openrouter`, per workspace (through the gateway, `gateway/meridian.ts`) | Existing, unchanged. The engine rule holds: no `fetch` outside `gateway/transport.ts`, and keys come from the resolver. |
| `src/engine/gateway/providers.ts` (`baseUrl https://openrouter.ai/api/v1`) | The provider table entry for the generation gateway. | Model/generation gateway. | as above | Existing. |
| `src/engine/assets/providers/openrouterImage.ts`, `openrouterSpeech.ts`, `openrouterVideo.ts` | Image, speech and video providers. They call the gateway and hold no key. | Model/generation gateway, capability-gated. | as above | Existing. Each is offered only where its capability is verified. |
| `src/engine/config/routes.ts`, `config/prices.ts`, `gateway/catalog.ts`, `assets/model-choice.ts`, `assets/video-profiles.ts`, `orchestrator/*`, `ops/batch.ts`, `claude/*` | Model choice, route and price configuration for generation and orchestration, and the orchestrator's model catalogue. | Model/generation configuration. Not decisioning. | as above | Existing. Priced from the provider's reported cost, not from an estimate. |
| `src/lib/meridian/credentials/contract.ts`, `credentials/resolve.ts`, `credentials/live-readiness.ts`, `settings/provider-config.ts`, `settings/server-actions.ts` | The credential contract, the resolver and Settings. `openrouter` and `openrouter_chat` are separate categories. | Credential contract. | — | Existing. The decisions engine reuses the `openrouter` category; no parallel key was added. |
| `src/components/openrouter-decision-controls.tsx`, `decision-engine-selector.tsx`, `setup/engine-choice.tsx` | The decision model field, the explicit connection test and the engine choice. | UI for the decisions engine. | Shows masked state only. | New. |
| `migrations/0132_openrouter_decisions.sql` | Widens the engine checks, adds the model and check tables, and provider identity on decision runs. | Schema for the decisions engine. | — | New. Forward only. Earlier migrations are unchanged. |
| `src/components/content-factory/orchestrator-*.tsx`, `src/lib/meridian/orchestrator/actions.ts`, `src/lib/meridian/factory/decode.ts`, `src/lib/meridian/embeddings/provider.ts` | Labels, model panels and decoding for the generation and orchestration paths. | UI and decoding. Not decisioning. | — | Existing. |

## Open decisions for the owner

1. **Copy generation with a workspace key.** Ordinary chat (copy generation) still uses only the deployment's `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL` for its model. A workspace's own OpenRouter key is not used there. Moving chat onto the workspace path needs the workspace's model choice for chat, and it changes what a workspace's key can do. This is a product decision.
2. **Which model JEV uses through OpenRouter.** JEV through OpenRouter uses the workspace's OpenRouter decision model. Whether JEV should choose its own pinned model is a product decision.
3. **Image input for `typesafe/jev-1.13`.** The catalogue lists it with image input; the recorded documentation does not. The question is whether TypeSafe's documentation says so, or a live check confirms it. Until then it stays text-only.
4. **Image input for JEV at all.** JEV's input contract is text-only in its own documentation for the TypeSafe backend. Through OpenRouter, JEV receives image evidence only when the selected model's profile takes images, and only as image parts.

## What was not verified

- **No live call has been made to OpenRouter in this change.** No OpenRouter key is available in this environment, so no paid request was sent. The catalogue read is public and was recorded (2026-10-25, 30 decision entries). Every other test uses a fixture or a fake fetch.
- **Live verification steps that remain for the owner:** (1) save a read-only OpenRouter key in Settings; (2) choose `typesafe/jev-1.14`; (3) run **Test the connection**, which sends one billable request; (4) confirm the returned model, the provider request id and the cost against the recorded `ceilingUsd` and `reportedCostUsd`; (5) for JEV over OpenRouter, run one decision with an image and confirm the lineage records the image as sent.
- The reported cost is stored as the provider reports it, and the ceiling is stored beside it. Meridian has no price table for this engine, so decision spend records the reported cost as reported, not as a price.
- The profile for each model is a claim about its documentation. No primitive of any model has been checked by a live request.
