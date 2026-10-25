# Outbound requests outside the engine gateway

The engine makes its provider requests only through the gateway (`src/engine/gateway`). Lib code makes its own: a direct `fetch`, or the
shared request helper `providers/http.ts`. Those requests are not held by the engine gateway or the budget ledger. This document says which
ones there are, what each one can cost or change, and which ones have no guard.

The source of truth is `src/lib/meridian/providers/direct-requests.test.ts`. It is an inventory the tests enforce:

- A new file that makes a request fails until it is classified there.
- An entry whose file no longer makes a request fails, so the inventory cannot go stale.
- A paid or side-effecting request must name a guard, and a guard must point at a test file that exists. Otherwise it is listed as BLOCKED.
- The BLOCKED list is asserted exactly. A path leaves it only by a change that the test records.
- No engine file calls `fetch` or the lib helper. Engine code reaches providers through an injected gateway transport.

## Kinds and guards

| Kind | Meaning |
| --- | --- |
| `paid` | The call costs money per request. |
| `side_effect` | The call writes outside Meridian: publishes, uploads, sends, or starts a job. |
| `read`, `probe`, `auth`, `internal`, `types`, `transport`, `transport_helper` | Reads, connection checks, sign-in, the sidecar, type declarations, and the transports themselves. |

| Guard | Meaning |
| --- | --- |
| `gateway` | The engine's gateway, with its credentials and ledger. |
| `ledger` | The text budget: the call is held before it is sent and settled once (`providers/generation-ledger.ts`). |
| `guarded` | A lib-level guard, such as the paused-ad state machine, with receipts and idempotent keys, and a test that proves it. |
| `none` | No guard in this code. The path is BLOCKED. |

## Guarded paths

- `ledger`: OpenRouter Decisions (`decisions/openrouter-engine.ts`). Covered by `decisions/decision-holds.test.ts`.
- `guarded`: the paused-ad creation and recovery state machine (`providers/meta-paused-ad.ts`, `content-factory/repurpose-paused-ad.ts`), and the
  organic publish with receipts (`content-factory/repurpose-organic.ts`). Each names its test.
- `gateway`: the engine's transport and the media, render and download adapters, which take the gateway's injected transport.

## BLOCKED: paid calls with no ledger hold

These are real paid calls made by lib code. None is held in the ledger, so none is capped by the monthly budget or the per-call ceiling.

- OpenAI decisions (`decisions/openai-engine.ts`)
- TypeSafe JEV decisions, the default JEV backend (`jev/router.ts`)
- Gemini perception (`perception/multimodal.ts`), omni (`production/providers/omni.ts`) and image generation (`providers/nano-banana.server.ts`)
- Higgsfield video generation (`production/providers/higgsfield.ts`)
- The paid embeddings API (`embeddings/external.ts`)

Image and video generation through these providers is therefore not governed by the budget. That is the largest gap in this inventory.

## BLOCKED: side effects with no idempotency or guard in this code

- Publishing to Facebook, Instagram, TikTok, YouTube and the Meta Graph (`distribution/*`), and the publish path that calls them (`publishing/engine.ts` forwards to them). Receipts are written; no idempotency key is sent.
- Meta ad calls (`providers/meta.ts`), Google Ads writes (`providers/google-ads.ts`), TikTok calls (`providers/tiktok.ts`).
- The paused publish that stores idempotency keys but has no test (`providers/publish-action.ts`).
- The Hypit client and the Hypit run and handoff (`hypit/client.ts`, `studio/hypit-run.ts`). The Meta publish that calls the client has an idempotency key and an approval step, but neither reaches the request in the client.
- Google Drive writes, including resumable uploads (`storage/drive.ts`, `storage/drive-resumable.ts`). A retry can duplicate a file.
- Outbound email (`notifications/email.ts`), alert webhooks (`alerts/deliver.ts`), and the job executor, which sends whatever request a job carries (`jobs/execute.ts`).
- The upload service's own request (`content-factory/repurpose-upload-service.ts`).

## What closes a gap

Route the path through the gateway and the ledger, or give it a guard with an idempotency key, receipts and a test. Then move its entry in
`direct-requests.test.ts` from `none` to `guarded` or `ledger`, name the test, and remove it from BLOCKED. The test fails until both are done,
so a gap cannot close silently.
