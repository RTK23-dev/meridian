# Claude client and roles (W3)

Implements Video Engine Bible **section 11** (Claude roles): the client that every Claude call goes through, the role
definitions, and the structured-output and retry rules of 11 and 11.2. The first role is `segmenter` (Bible 6.2 step 4,
11.1). The step's budget follows **14.1** (authorize, call, reconcile). Prompt caching and the Batch API are not
implemented; they depend on the route (Bible 20.3 item 6), see `STATUS.md`.

## Files

- `client.ts`: `runRole(deps, role, request)`, the one entry point. It validates the input, checks the reservation belongs
  to the request and workspace, checks the provider is connected, prices the call, authorizes it, calls once through
  `structuredChat`, and retries once on a `StructuredOutputError`.
- `role.ts`: `RoleDefinition`, what a role is: capability, prompt reference, input and answer contracts, the token
  estimate, the retry rule and the user content.
- `roles/segmenter.ts`: the segmenter. Input: frames (data URLs), transcript words and cut times. Answer: segments with
  the decided fields of `DnaSegment`. Motion, brightness and loudness are not in the answer; the media functions measure them.
- `rates.ts`: Claude token rates (Bible 11.1), keyed by OpenRouter id. A model with no rate has no estimate, and the call
  refuses (`unknown_price`).
- `errors.ts`: `RoleAnswerError`, the typed error when the retry also fails. Kind `provider`, not retryable.
- `test/`: helpers and recorded fixtures (see `test/fixtures/README.md`).

## How a call is made

1. Validate the input against the role's contract. A bad input is refused before anything is reserved.
2. Check the reservation's `requestId` and `workspaceId`. A mismatch is `not_found`: nothing is sent to another tenant.
3. Route the capability (`config/routes.ts`) and check the provider is connected. Not connected: throw `config` and send
   nothing, hold nothing.
4. Authorize the call with `paidCall` (`gateway/paid.ts`) on the reservation. The estimate is the role's tokens at the
   routed model's rate (segmenter: 26k in, 3k out, Sonnet, $0.082). A refused call returns `status: "refused"`.
5. The key is `contentHash({ role, promptVersion, model, input })`. A key already on the ledger returns
   `status: "duplicate"` and makes no call.
6. The answer is validated by `structuredChat` against the role's schema. A `StructuredOutputError` is held at the
   estimate (the bill is not in the error). The retry is a second `paidCall` under its own key, with the failed checks
   (paths and codes only) and the role's rule appended. The discarded answer is not sent back.
7. A second failure throws `RoleAnswerError` and the stage fails. A success returns `status: "done"` with the value and
   the call records (model, answering model, generation id, prompt version, tokens, `usage.cost`, ledger entry id).

## Untrusted data

The transcript and the video's facts go in `<untrusted-data name="...">` blocks, JSON-encoded with `<`, `>` and `&`
escaped (`prompts/untrusted.ts`), so no value can close its block. Frames are sent as `image_url` parts, and only as data
URLs of images. The prompt tells the model that every block is data and that instructions inside it are never followed.

## Rules

- No `fetch`, no `process.env`, no logging of prompts or answers, no Meridian credential code. `boundaries.test.ts` checks
  this for `claude/` and `prompts/`.
- Every call reserves budget and writes a ledger entry with its idempotency key (`budget/`, via `gateway/paid.ts`).
- The contract for an answer is zod. The answer's word ids and time spans are checked against the input, so a bad answer
  is caught by the same retry.
