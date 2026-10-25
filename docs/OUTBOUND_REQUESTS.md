# Outbound requests outside the engine gateway

The engine makes its provider requests only through the gateway (`src/engine/gateway`). Lib code makes its own: a direct `fetch`, or the
shared request helper `providers/http.ts`. Those requests are not held by the engine gateway or the budget ledger. This document says which
ones there are, what each can cost or change, and how each one is guarded.

The source of truth is `src/lib/meridian/providers/direct-requests.test.ts`. It is an inventory the tests enforce:

- A new file that makes a request fails until it is classified there.
- An entry whose file no longer makes a request fails, unless it is a disabled caller that still wires its gate.
- No paid or side-effecting entry may be unguarded: each is held in the ledger, guarded by a tested guard, or disabled.
- Each disabled entry names a capability in `providers/capability.ts`, every capability is named by a classified file, and each name is
  passed to its gate in production code.
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
| `guarded` | A lib-level guard, such as the paused-ad state machine, with receipts, idempotent keys, and a test that proves it. |
| `disabled` | The path's default transport or fetch refuses before any request is made (`providers/capability.ts`). Its test proves it. |

## Guarded paths

- `ledger`: OpenRouter Decisions (`decisions/openrouter-engine.ts`). Covered by `decisions/decision-holds.test.ts`.
- `guarded`: the paused-ad creation and recovery state machine (`providers/meta-paused-ad.ts`, `content-factory/repurpose-paused-ad.ts`), and
  the organic publish with receipts (`content-factory/repurpose-organic.ts`). Each names its test.
- `gateway`: the engine's transport and the media, render and download adapters, which take the gateway's injected transport.

## Disabled paths (fail closed)

These paths are off. Their default transport refuses before any request is made, so a call sends nothing and is not retried. Tests that
inject a fixture transport still exercise the module's logic. Each capability is listed in `DISABLED_CAPABILITIES`
(`providers/capability.ts`) with the reason it is off.

Paid calls with no ledger hold:

- `decision.openai`: OpenAI decisions (`decisions/openai-engine.ts`)
- `decision.typesafe_jev`: TypeSafe JEV decisions, the default JEV backend (`jev/router.ts`)
- `perception.gemini`: Gemini perception (`perception/multimodal.ts`)
- `generation.gemini_omni`: Gemini omni (`production/providers/omni.ts`)
- `generation.gemini_image`: Gemini image generation (`providers/nano-banana.server.ts`)
- `generation.higgsfield_video`: Higgsfield video (`production/providers/higgsfield.ts`)
- `embeddings.external`: the paid embeddings API (`embeddings/external.ts`)

Side effects with no idempotency guard:

- `publish.facebook`, `publish.instagram`, `publish.tiktok`, `publish.youtube`: social publishing (`distribution/*`). The guarded path is
  the organic Facebook publish with receipts.
- `publish.paused_action`: the paused publish action (`providers/publish-action.ts`).
- `publish.meta_video_upload`: the Meta video upload (`content-factory/repurpose-upload-service.ts`).
- `ads.meta_write`, `ads.google_ads_write`, `ads.tiktok_write`: ad writes. Their transports are gated per provider in `providers/live.ts`. The
  guarded paused-ad path is `providers/meta-paused-ad.ts`.
- `hypit.client`: the Hypit client and run (`hypit/client.ts`, `studio/hypit-run.ts`).
- `drive.write`: Google Drive writes, including resumable uploads (`storage/drive.ts`, `storage/drive-resumable.ts`). Files are kept in
  Postgres unless Drive is connected.
- `email.send`: outbound email (`notifications/email.ts`).
- `alerts.webhook`: alert webhooks (`alerts/deliver.ts`) and the job executor's alert delivery (`jobs/execute.ts`).

A disabled capability is also not retried. `sendWithRetry` (`providers/http.ts`) repeats only GET and PUT, or a request the caller marks
idempotent. The artifact upload (`storage/artifact-upload.ts`) stops at once on a disabled capability. The image adapter returns
`NOT_CONNECTED` for one, so the attach flow releases its budget reservation.

Negative tests:

- `providers/capability.test.ts`: each capability refuses without a request, and a disabled capability is not retried.
- `providers/disabled-paths.test.ts`: the image adapter, the embeddings call and the email send, through their production defaults, send no
  request.

Live behavior is not verified by design. These tests use fixtures and fake transports only.

## What closes a gap

Route the path through the gateway and the ledger, or give it a guard with an idempotency key, receipts and an uncertain state, and a test
that proves it. Then turn its capability on: remove it from `DISABLED_CAPABILITIES`, replace the gate with the real transport, move its
inventory entry from `disabled` to `guarded` or `ledger`, and name the test. The inventory test fails until these changes are made, so a
gap cannot close silently.
