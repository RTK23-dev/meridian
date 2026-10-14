# STATUS: engine render (W10): HyperFrames cloud adapter, integrity hook, zip

Phase E1, wave B. Branch `engine/e1-w9-w10`, cut from `code/beautiful-cori-1zfk11` (7fd32ae). Covers `src/engine/render/`.
Details: `README.md` in this folder.

## Done

- `HyperframesCloudAdapter` implements the `RenderAdapter` interface (ready, submit, poll, fetchResult) over an injected
  transport. Upload (direct-uploads, presigned PUT, complete with 409 retries), submit, poll and download. The API key
  goes only to the API, never to the presigned URL or the video URL.
- `renderComposition()`: checks the key first, then holds budget on the reservation (ledger written before the call,
  keyed by `Composition.contentHash`), submits with `Idempotency-Key` = `Composition.contentHash`, polls, downloads,
  reconciles, runs the injected integrity hook, and stores the video. Returns a `RenderedVideo` that passes
  `renderedVideoSchema`. A refused budget, a missing key or a tampered composition makes no request and writes no entry.
  A resumed or repeated render re-sends the same key and keeps one ledger entry.
- `zip.ts`: deterministic archive writer (sorted names, fixed timestamps, zlib deflate). Tested by an independent reader.
- `recorded.ts`: constructed responses for the adapter tests. They follow the CLI 0.8.154 client source. They are not
  captured from the live API.

## Tests run in this worktree

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/render/**/*.test.ts'`: **20 pass, 0 fail.**
  Scripted transport: request order and methods, the key header and its derived upload key, the presigned PUT carrying
  no key, 409 backoff, 429 and 401 mapping, the poll and download flow, budget refusal, no-key refusal, resume with the
  same key, integrity failure (nothing stored), tampered files, and poll timeout (hold kept).
- `npm run typecheck`: exit 0. `npm run lint`: exit 0, 0 errors, 4 warnings, all in existing `src/components/` files.
- Full `npm test` on the final state: exit 0 (see `../compose/STATUS.md`).
- Base: the branch was cut from `code/beautiful-cori-1zfk11` at 7fd32ae. The lead branch has moved on since; not rebased
  or merged here (the lead integrates). This code uses no `ENGINE_ERROR_KINDS` added later.

## Owner's live run (E1 acceptance, Bible 6.11 and 19)

1. Call `renderComposition` with `fetchTransport`, a key from the credential resolver, and a real reservation from
   `reserve()`. Use the E1 acceptance EDL (one stock clip, one TTS voice, three components). Record the render id, the
   video id, the cost in the ledger, the artifact ids, and the output file.
2. Run `ffprobe` on the output: 1080 × 1920, 30 fps, duration within 100 ms of the EDL, audio present.
3. Ten test renders: record each bill. Set `render_hyperframes_cloud` in `prices.ts` to a verified price. Until then
   the render line is `budgets.fixedPerMasterUsd.render` (0.05), and each ledger entry says it is an estimate.
4. Submit the same composition twice. Check that HeyGen returns the same render id and bills once. The adapter assumes
   this, and it is not verified.
5. Check `resolution: "1080p"` and `aspect_ratio: "9:16"` on an `asset_id` project. If the output is not 1080 × 1920,
   change `RENDER_SETTINGS` in `hyperframesCloud.ts`.

## NOT-VERIFIED (read from the CLI source, never called)

- Every endpoint and body in the README table. Source: `node_modules/hyperframes/dist/chunk-NAMGMP3R.js`,
  `chunk-IYLHJV34.js`, `render-LUAMJOON.js`.
- The status words: `completed` and `failed` are terminal (the CLI's `pollUntilTerminal`). Any other word is treated as
  still running. A live status outside that set would loop until the poll limit.
- Whether `Idempotency-Key` deduplicates renders on HeyGen's side.
- Whether a failed render is billed, and whether any response carries a bill. Neither is known.
- The render price (`render_hyperframes_cloud` is null in `prices.ts`).

## Interpretations (lead to confirm)

- A failed render is reconciled at its hold, flagged as an estimate, and the error is retryable. The orchestrator
  decides when to fall back (Bible 6.11: after two failures).
- A poll that never finishes is a retryable error and keeps the hold. A resumed job re-sends the same key.
- The render-integrity rule is injected (`verifyIntegrity`). The adapter passes the expected 1080 × 1920, 30 fps, and the
  EDL duration. The tolerance comes from `thresholds.render.durationToleranceMs`, as the probe's responsibility.
- The adapter does not write the video itself: `storeVideo` (eng-pipeline) returns the URI.
- Render settings and polling limits are constants in `hyperframesCloud.ts`. Bible 17.2 rule 3 wants them in
  `engine/config/` (W1 owns config). Move them there in a follow-up.

## Not done

- `remotionLambda.ts` and `shotstack.ts` (E5, Bible 9.3).
- `VideoEngine` (`src/lib/meridian/video/engine.ts`): not implemented. Its `submit`, `poll` and `collect` take and return
  Hypit job types, which a composition render does not map to. Wiring is E2's job, and the interface must not change here.
- A HeyGen credential category in `credentials/contract.ts` (outside this folder). Until it exists, the adapter gets its
  key from the injected `credential()` function only.

## Blockers

- Owner: the live run above (keys, the first bill, and the idempotency check).
- eng-media-assets: the render-integrity probe and rule (`verifyIntegrity`).
- eng-pipeline: `resolveAsset` and `storeVideo` (storage), and the ledger store (`LedgerStore`) on Postgres.
- Credentials (E2): a HeyGen category in the resolver.
