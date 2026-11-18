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
  the organic publish with receipts (`content-factory/repurpose-organic.ts`), and outbound email (`notifications/email.ts`: one send per
  attempt, an `Idempotency-Key` of `<invite id>:<attempt>`, the invite marked `sending` first and `uncertain` when the answer is lost;
  `notifications/email.test.ts`, `notifications/invite.test.ts`). Alert webhooks (`alerts/deliver.ts`, `alerts/delivery-job.ts`, run by
  `jobs/execute.ts`): the attempt is recorded as `sending` before the request, sent once with an `Idempotency-Key` of
  `<alert id>:<attempt>`; 2xx is `sent`, 4xx `failed` (retried up to three attempts, then `dead`), and no answer or 5xx `uncertain`,
  which is never re-sent: the Alerts center tells the admin to check the receiving system (`alerts/delivery-job.db.test.ts`). Google
  Drive writes (`storage/drive.ts`, `storage/drive-resumable.ts`): a small file is created under a Drive id from `files.generateIds`,
  reserved in Postgres first (`drive_reserved_ids`, migration 0165), so a racing writer or a retry after a lost answer gets Drive's 409,
  which counts as success only after the file's properties and sha256 are read back (`storage/drive-reserved-ids.test.ts`); large files
  use the resumable session recorded in Postgres (`storage/drive-resumable-put.test.ts`). Each names its test. All are fixture-tested;
  no live webhook or Drive write is recorded.
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

- `publish.instagram`, `publish.tiktok`, `publish.youtube`: social publishing (`distribution/*`). Off. Facebook Page publishing is on: every
  organic publish goes through `distribution/service.ts`, which writes a claim (`organic_publish_claims`) before the call, so a creative is
  not posted twice and an unknown outcome is `uncertain` until a person checks the platform.
- `publish.paused_action`: the paused publish action (`providers/publish-action.ts`).
- `publish.meta_video_upload`: the Meta video upload (`content-factory/repurpose-upload-service.ts`).
- `ads.meta_write`, `ads.google_ads_write`, `ads.tiktok_write`: ad writes. Their transports are gated per provider in `providers/live.ts`. The
  guarded paused-ad path is `providers/meta-paused-ad.ts`.
- `hypit.client`: the Hypit client and run (`hypit/client.ts`, `studio/hypit-run.ts`).

A disabled capability is also not retried. `sendWithRetry` (`providers/http.ts`) repeats only GET and PUT, or a request the caller marks
idempotent. The artifact upload (`storage/artifact-upload.ts`) stops at once on a disabled capability. The image adapter returns
`NOT_CONNECTED` for one, so the attach flow releases its budget reservation.

Negative tests:

- `providers/capability.test.ts`: each capability refuses without a request, and a disabled capability is not retried.
- `providers/disabled-paths.test.ts`: the image adapter and the embeddings call, through their production defaults, send no
  request.
- `distribution/disabled-entry-points.test.ts`: the Facebook, Instagram, YouTube and TikTok publish channels and the paused Meta publish,
  through their production defaults. A refusal is reported as `NOT_CONNECTED` with the gate's message, and no request is sent.
- `content-factory/upload-default-gate.test.ts`: the Meta video upload through its production default, on the test database. With no
  readable video it is blocked; with readable bytes the `publish.meta_video_upload` gate refuses it. No receipt is stored either way.
- `studio/hypit-default-gate.test.ts`: the Hypit start, poll and artifact calls, each given the `hypit.client` gate. The studio run itself
  needs a saved credential from the database, so it is not run end to end here.
- `providers/disabled-production-defaults.test.ts`: the OpenAI decisions engine, the TypeSafe JEV provider, the Gemini perception provider,
  the Higgsfield and Gemini Omni submissions, and the paused Google Ads and TikTok publishes, each through its production default, with a
  workspace key supplied through the module's own credential seam. The brand-level paused publish (`publish.paused_action`) is covered for
  Google and TikTok, through the database. The gate's refusal is reported as a refusal: a refused Higgsfield or Omni submission is a failed
  job, not one of unknown outcome, and a refused perception call is `not_configured`, not a network failure.

Live behavior is not verified by design. These tests use fixtures and fake transports only.

## What closes a gap

Route the path through the gateway and the ledger, or give it a guard with an idempotency key, receipts and an uncertain state, and a test
that proves it. Then turn its capability on: remove it from `DISABLED_CAPABILITIES`, replace the gate with the real transport, move its
inventory entry from `disabled` to `guarded` or `ledger`, and name the test. The inventory test fails until these changes are made, so a
gap cannot close silently.
