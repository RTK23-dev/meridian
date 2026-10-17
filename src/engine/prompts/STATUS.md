# Role prompts: status (W3, task A5)

**model_chooser@1.md (contract v8, 2026-10-17).** The four-part prompt for the model_chooser (Bible 10.5 step 2; see
`../claude/roles/STATUS.md`). Its hash is pinned in `load.test.ts`.

**scriptwriter@1.md (contract v8, this branch).** The four-part prompt of Bible 11.2 for the scriptwriter (see `../claude/roles/STATUS.md`).
Its hash is pinned in `load.test.ts`. A change to the file is a new version (scriptwriter@2), not an edit.
**scriptwriter@2.md (contract v8, round 2 on this branch).** The four-part prompt of Bible 11.2 for the scriptwriter (see
`../claude/roles/STATUS.md`). Version 2 changes the copy run to six words (COPY_RUN_WORDS = 6) and adds the language rule: the brief's stated
language, else `referenceLanguage` (the DNA transcript's detected language, null when unknown), else the brief's text language; the answer
names the language. Its sha256 is pinned in `load.test.ts` with `scriptwriter@1.md`, which is kept as shipped and still pinned. A change to
a file is a new version, not an edit.

## E5 generation variants (this worktree, `agent-a88fc87eb7108bf53`)

- **`variant_writer@2.md`** is new, a complete file for the role's two tasks: `lines` (the hook and language lines of @1, unchanged in
  substance) and `product_prompts` (a new generation prompt for each product shot, naming the variant's product and not the master's, with
  no quotation marks). `variant_writer@1.md` is kept as shipped and its bytes are pinned. The role's version is 2.
- Both versions are pinned in `load.test.ts` (`variant_writer@1` and `variant_writer@2`). A change to either is a new file and a new number.
- The planner's rule "No names" (`planner@1.md`) is not changed. The product variant's prompt names the product by its kit's name, as the
  lead asked. That is an open policy question (`variants/STATUS.md`, blocker 5).

## E3 integration pass (branch `eng-e3-wiring`)

- **`director_check@2.md`** is new: a copy of `@1` with the shot table's `beatText` described as untrusted script text, which the
  director judges the picture from and never copies into a prompt edit. `@1` is unchanged and pinned in `claude/roles/director_check.test.ts`.
- The loader's pin test (`load.test.ts`) still pins `segmenter@1` only; the director pins are in its role test.

Built 2026-10-14 by eng-pipeline on branch `eng-a5-claude-client`. Not pushed.

## Done (fixture-tested)

- `segmenter@1.md`: the segmenter prompt, four parts (Bible 11.2). Its shot-type, layer and beat-role vocabulary matches
  `contracts/analysis.ts` and `contracts/request.ts`.
- `load.ts`: versioned loading with a name check, a typed `config` error for a missing version, and a content hash
  (`sha256:` of the file bytes). The prompt's hash is pinned in `load.test.ts`.
- `untrusted.ts`: named untrusted-data blocks, JSON-encoded with `<`, `>` and `&` escaped (tested: a value that contains
  the closing tag cannot end its block).
- Tests: `load.test.ts` (5), `untrusted.test.ts` (4). Both pass.

## Not done

- No caching markers. The cached part of the prompt is the `## Reference material` section; whether the route passes
  caching through is open (Bible 20.3 item 6).
- Only `segmenter@1` exists. The other roles (`genome`, `planner`, `director_check`, and so on) get their own files when
  they are built.

## Owner's live check

The prompt is exercised by the segmenter's live check in `src/engine/claude/STATUS.md`. Nothing here is separate.

## frame_reader@1 (eng-detectors)

`frame_reader@1.md` is the prompt of the `frame_reader` role (`claude/roles/frame_reader.ts`). Its hash is pinned in
`frame_reader.test.ts`. It has the four parts of Bible 11.2. Its output is measurements only: no free text, and the answer contract
refuses any key it does not name.
