# Claude client and segmenter: status (W3, task A5)

Built 2026-10-14 by eng-pipeline on branch `eng-a5-claude-client`, cut from `code/beautiful-cori-1zfk11` (gateway commit
`a61a340`). Not pushed. The lead merges.

## Done (fixture-tested)

- `client.ts`: `runRole(deps, role, request)` with `deps = { gateway, ledger, now }`.
  - Every call is one `paidCall` on the request's reservation (`budget/`), so each call has a ledger entry with its
    idempotency key, the estimate, the reservation hold and the reconciled actual.
  - The key is `contentHash({ role, promptVersion, model, input })`. A repeat returns `status: "duplicate"` and makes no
    call. A refused call returns `status: "refused"` and makes no call.
  - One retry on a `StructuredOutputError`, as its own paid call with its own key. The retry note names the failed checks
    by path and code only. The discarded answer is not sent back. A second failure throws `RoleAnswerError`
    (kind `provider`, not retryable, `attempts`, `issues`).
  - A null `usage.cost` reconciles to the held amount, flagged `actualIsEstimate: true`.
  - Not connected: throws `config` before any reservation, and sends nothing.
  - Unknown model rate: throws `unknown_price` before any reservation.
  - Input, ids, attempt number and reservation tenancy are checked before any call.
- `roles/segmenter.ts`: role `segmenter`, capability `llm.analysis`, prompt `segmenter@1`, input contract (frames as
  data-URL images, transcript words, cut times, with cross-checks), answer contract built from the `DnaSegment` field
  shapes (motion, brightness and loudness omitted, since ffmpeg measures them), and answer checks that need the input
  (word ids in the transcript, time order without overlap, ends inside the video, unique segIds).
- `prompts/segmenter@1.md`: four parts (Bible 11.2). Transcript, video facts and frames are untrusted data.
- `rates.ts`: Opus $4/$20, Sonnet $2/$10, Haiku $1/$5 per million tokens in/out (Bible 11.1). The segmenter estimate is
  26k in and 3k out at Sonnet, $0.082.
- Tests: `client.test.ts` (17), `roles/segmenter.test.ts` (11), `rates.test.ts` (3), `boundaries.test.ts` (5),
  `../prompts/load.test.ts` (which pins the hash of `segmenter@1.md`), `../prompts/untrusted.test.ts`. All 45 pass.
  Recorded fixtures are under `test/fixtures/` (see its README: they are authored in the recorded shape, not live captures).

## Not done, and why

- **Prompt caching and Batch API.** Not implemented. Whether OpenRouter passes Anthropic prompt caching and batch through is
  unverified (Bible 20.3 item 6). The route does not declare either, so the client sends neither. Bible 11.4 says
  `segmenter` runs through Batch when `priority: batch`; that wiring waits for the route.
- **Live calls.** None. Agents hold no keys (North Star decision 1). Every number here is a fixture.
- **The `verified` flag.** Every `llm.*` route is `verified: false` in `config/routes.ts`. The client does not refuse an
  unverified route, so the live run finds a wrong model id as a provider error. The flag is changed by eng-contracts
  after the live check.

## Decisions to confirm (lead)

1. **Token rates live in `claude/rates.ts`.** They are configuration (Bible 17.2 rule 3) and belong in
   `config/prices.ts`. `config/` is outside this task's write scope, so they are here, with a note. Move them with
   eng-contracts.
2. **The ledger stage is `claude_roles`** (`budgets.fixedStages.claudeRoles`), the label the reservation lines use. The
   `LedgerEntry` contract has no role or prompt-version field. The role and version are in the idempotency key and in
   `RoleCall` (returned to the caller for the manifest). If the lead wants them on the ledger row, eng-contracts adds
   optional fields (a version bump, Bible section 4 note).
3. **The segmenter answer is `{ segments: SegmenterSegment[] }`,** not a bare `DnaSegment[]`. A strict JSON schema needs an
   object at the root. The analyze stage (W6) merges the ffmpeg measurements and makes the `DnaSegment[]`.
4. **`maxOutputTokens` is 3000,** the same as the priced output. The output cannot exceed the reservation. If a live
   answer is cut short, raise the cap and the estimate together (a Bible 11.1 change). The input side is an estimate
   (26k). At most 60 frames at 768 px is about the same size, but that is unverified.

## Gaps for W2, W12 and W14 (open)

- **A failed call keeps its hold.** This is `paid.ts` behaviour, and it is kept for a provider that billed. But a call with
  no answer (a timeout or a 5xx) stays counted against the reservation until it closes. The job retries with
  `attempt: 2` (a new key). Decide whether an HTTP error with no generation id reconciles to zero. Bible 5.1 says a retry
  costs nothing if the provider did not charge.
- **A refused retry cannot resume.** If the first answer is invalid, its call is billed and the retry is refused by the
  budget, the request pauses. On resume, the first key returns `duplicate`, the invalid answer was never stored, and
  the stage has no answer. The orchestrator must keep every `RoleCall` (with its issues) in the job record, and W14 owns
  the replay decision.
- **Concurrency.** `authorizeCall` is atomic on the key only if the Postgres store has a unique index on the key, with a
  row lock on the reservation (`budget/README.md`). Two jobs must not run the same call at once.
- **Usage on invalid answers.** Done by the lead (2026-10-14): `StructuredOutputError` now carries OpenRouter's usage, so a
  billed answer that fails its contract is recorded at its reported cost; with no reported cost the hold stands, flagged.
- **Prompt files load from disk** (`prompts/<role>@<n>.md`, read relative to the module). A bundled deploy must ship the
  `.md` files beside the code.
- **Strict JSON schema.** The answer schema has optional fields and length and range keywords. OpenRouter's strict
  `json_schema` mode may reject optional fields for some models. The live check finds out (see below).

## Owner's live check (exact steps)

Prerequisites: the gateway's live run has passed (`src/engine/gateway/STATUS.md`): `OPENROUTER_SHARED_DEFAULT=deployment`
and `OPENROUTER_API_KEY` on the deployment, and `verifyRoutes` listing `anthropic/claude-sonnet-5.5`.

1. `verifyRoutes(gateway, ["llm.analysis"])`. Expect `anthropic/claude-sonnet-5.5` with `listed: true`. If not, the
   model id is wrong: stop and report it (eng-contracts changes the route).
2. Reserve a budget: `reserve(ledger, { mode: "cap", ... })` for a test request with a $1 budget (owner sets the value).
   Use a real 5 to 10 second example reel: cut times, frames at each cut and 2 per second (at most 60, at 768 px long
   side, as PNG or JPEG data URLs), and the transcript words (from the speech-to-text vendor, when chosen).
3. Call `runRole({ gateway, ledger, now }, segmenter, { requestId, workspaceId, reservationId, input })` once.
4. Record: `status`; each `calls[]` entry (generation id, `answeredBy`, prompt and completion tokens, `costUsd`,
   `ledgerEntryId`, `idempotencyKey`); the ledger row (`estimateUsd` should be 0.082, `actualUsd`, `actualIsEstimate`).
5. Compare `costUsd` with the OpenRouter activity page for the generation id. The two should match to 4 decimals.
6. Call `runRole` again with the same input. Expect `status: "duplicate"`, and no new generation on the activity page.
7. Check the strict schema. If OpenRouter rejects the request with a 400, record the provider's error message (not the
   prompt) and stop. Do not change the schema in this step.
8. Check the frames. Confirm the routed model reads them: the answer's `segments` should cover the cut times.
9. Attach to the PR: the outcome, the calls, the ledger rows, the activity-page costs, and the answer JSON (model output,
   not a secret). Replace the fixtures in `test/fixtures/` with the recorded responses and run `client.test.ts` again.
   Do not attach the prompt text or any key.

Pass means: one answered call with a matching cost, one duplicate with no call, and an answer that matches the contract
(or a typed failure recorded with its issues). Bible 20.3 item 6 (caching and batch) stays open until the route supports
them.
