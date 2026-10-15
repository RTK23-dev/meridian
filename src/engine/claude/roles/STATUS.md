# STATUS: Claude roles added in E5 (W13)

Branch `eng-e5-variants`. Covers `variant_writer.ts` and its test in this folder, and `src/engine/prompts/variant_writer@1.md`. The
other roles of this folder are eng-pipeline's and are not changed here. Nothing is pushed.

## variant_writer (Bible 6.13, 11.1)

- Stage `variants`. Capability `llm.check` (Haiku). Prompt `variant_writer@1` (pinned by hash in the test). Output cap 600 tokens.
  Estimate 2k in and 0.5k out at Haiku's rate: $0.0045 a call (under the Bible's $0.01).
- Input: the beats to write (a hook beat, or every beat for a language), the variant's attribute and label, the target language and
  the approved claims. The beats are inside an untrusted-data block.
- Answer: one `lines` entry for each beat it was given, with no extra or repeated beat. Every number of a beat is kept in its line.
  A line is non-empty and at most 300 characters. A failed answer gets one retry under its own key.
- Nothing calls it yet. It is for the variant sub-graph (`variants/STATUS.md`, blocker 3).

## Tests

`variant_writer.test.ts` (17): the input and answer contracts, the Haiku route and the estimate, the pinned prompt hash, a call through
`runRole` on a reservation (the ledger row carries `role` and `promptVersion`), a retry that answers, and a failed retry that fails.

## Live (owner)

Run `runRole` with `variant_writer` on the hook beat of one recorded request, through the Haiku route. Record the answer, the ledger
row and the role-call row. Haiku's rate is still $1 / $5 (prices@2, an owner check).
