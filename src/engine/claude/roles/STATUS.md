# STATUS: Claude roles added in E5 (W13)

**model_chooser (contract v8, 2026-10-17).** `model_chooser.ts`: Haiku (llm.check), stage plan, prompt `model_chooser@1.md`. Input: up to 40
calls named `c1..cN`, each with shot, output, visual type, class, seconds, frames, reference count and up to 12 candidates (id, catalog
capabilities, price). Answer: `{ picks: [{ callId, modelId, reason (max 300) }] }`, strict in shape, loose on ids (the code checks them in
`assets/model-choice.ts`). Estimate 12k in / 2k out (initial; Bible 11.1 has no row for this role). Tests: `model_chooser.test.ts` (4);
recorded answer `test/fixtures/openrouter-model-chooser-ok.json` (authored, not a live capture).

**scriptwriter (contract v8, this branch).** `scriptwriter.ts`: Opus (llm.direction), stage write_script, prompt `scriptwriter@1.md`. Its
input carries the brief, its sources, the attachments' types and notes, the reference's structure (genome, genes, segments with durations),
the constraints and the approved claims. The reference's transcript is an input of the answer check only and is never sent (the test
asserts that). The answer contract refuses copied runs (COPY_RUN_WORDS = 3, a named constant, see `../../jobs/STATUS.md` decision 4), a
**scriptwriter (contract v8, round 2 on this branch).** `scriptwriter.ts`: Opus (llm.direction), stage write_script, prompt
`scriptwriter@2.md` (`@1` is kept and pinned). Its input carries the brief, its sources, the attachments' types and notes, the reference's
structure (genome, genes, segments with durations), the constraints, the approved claims and `referenceLanguage` (the DNA transcript's
detected language, null when unknown). The writer's language rule: the brief's stated language, else `referenceLanguage`, else the language
of the brief's own text.
The answer names its language. The reference's transcript is an input of the answer check only and is never sent (the test asserts that).
The answer contract refuses copied runs (COPY_RUN_WORDS = 6, a named constant, lead decision 2026-10-17, see `../../jobs/STATUS.md`), a
script over maxMs, a forbidden term, an emphasis word outside its beat, an unknown source label and a bad language tag. Tests:
`scriptwriter.test.ts` (12) on the recorded answers in `../test/fixtures/openrouter-scriptwriter-*.json`. The live run is the owner's.
`model_chooser` (contract v8) is not built here: another agent builds its call.

Branch `eng-e5-variants`, then this worktree (`agent-a88fc87eb7108bf53`). Covers `variant_writer.ts` and its test in this folder, and the
prompts `variant_writer@1.md` (kept as shipped) and `variant_writer@2.md`. The other roles of this folder are not changed here.

## variant_writer (Bible 6.13, 11.1)

- Stage `variants`. Capability `llm.check` (the check route). Prompt `variant_writer@2` (the role's version; `@1` is kept and pinned).
  Output cap 600 tokens. The estimate is 2k in and 0.5k out, $0.0045 a call at the check route's rate (under the Bible's $0.01).
- Two tasks, one role, one input union (`task`):
  - `lines`: the beats to write (a hook beat, or every beat for a language), the variant's attribute and label, the target language and the
    approved claims. The answer has one `lines` entry for each beat, no extra or repeated beat, every number of a beat kept, and each line
    non-empty and at most 300 characters.
  - `product_prompts` (new in @2): the generated product shots to rewrite, each with the master's prompt, and the variant's product name (its
    kit's name) and the master's. The answer has one `prompts` entry for each shot. Each prompt names the variant's product, not the master's,
    has no quotation marks, and is at most 300 characters.
- Both tasks are inside an untrusted-data block. A failed answer gets one retry under its own key.
- Called by `variants/writer.ts` (`writeVariantText`) from the variants stage's writer phase (`jobs/handlers/variants.ts`).

## Tests

`variant_writer.test.ts` (23): the input contracts of both tasks, the answer contracts (the lines checks, the product checks), the JSON
schema, the estimate, the user content, the pinned bytes of @1 and @2, and a call through `runRole` on a reservation (the ledger row carries
`role` and `promptVersion` @2), a retry that answers, and a failed retry that fails. `prompts/load.test.ts` pins both versions.

## Live (owner)

Run `runRole` with `variant_writer` on the product prompts of one recorded request, through the check route. Record the answer, the ledger
row (its `promptVersion` must read `variant_writer@2`) and the role-call row. The check route's rate is still $1 / $5 (prices@2, an
owner check).

## frame_reader (eng-detectors)

- `frame_reader.ts` (+ `frame_reader.test.ts`, 12 tests): Haiku with vision, `llm.check`, stage `analyze_reference`, prompt
  `frame_reader@1`. Reads up to 24 frames (768 px) for captions, overlay boxes, a text word count, and shake and speed-ramp
  judgements, as measurements only. The answer is strict with no string field except fixed enums (a test walks the JSON schema).
- Estimate 12k in and 2k out ($0.022). The output cap is 2k, not the 1k Bible 11.1 proposes (owner to confirm).
- Used by `analyze/frameReader.ts` (analyze, through `analysisReadings`) and `analyze/renderReadings.ts` (the render review).
- Live (owner): see `analyze/STATUS.md`, item 6 of the live steps.
