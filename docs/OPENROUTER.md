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

1. **Which model JEV uses through OpenRouter.** JEV through OpenRouter has no model setting of its own. It uses the workspace's OpenRouter decision model (`typesafe/jev-1.14` by default, pinned), the same one the OpenRouter Decisions engine uses. Whether JEV should choose its own pinned model is a product decision. Nothing has been changed here.
2. **`typesafe/jev-1.13` is verified for text only.** Its documentation states no image support, so the engine refuses images for it.
3. **Score-level and choice-criteria shapes.** The request shape follows the documentation's published examples. A single live call on a real key is needed to confirm the shapes the API accepts for all three question types before the engine is treated as live-verified.

## What was not verified

- No live call was made to OpenRouter or TypeSafe. Every test uses a fixture fetch stub or a fake router. The browser check exercised the connection test without a key, which sends nothing, and the JEV backend control with no keys saved.
- JEV through OpenRouter takes no images. The shared gate removes images before any engine declared text-only is called, and JEV is declared text-only, so an image-bearing decision reaches OpenRouter without them. Lifting that needs a decision about JEV's image contract, not a code change alone.
- The reported cost is stored as the provider reports it. Meridian has no price for this engine, so decision spend records its cost as unknown.
