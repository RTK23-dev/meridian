# Role prompts: status (W3, task A5)

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
