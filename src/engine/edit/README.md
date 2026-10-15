# Edit (W8): the deterministic editor and the EDL rules

Implements Video Engine Bible section 8.2 (the editor), section 8.3 (the rules every EDL must meet), and the edit stage of
section 6.8. Pure code: no model call, no clock, no environment. The same inputs give the same EDL, id and content hash.

## Files

| File | What it is |
| --- | --- |
| `editor.ts` | `buildEdl(input)`: the 8.2 steps in order. Returns the EDL, its checks, the failing shots and plain-words notes. `editIdentity` gives the id of a run. |
| `rules.ts` | One named pure function per 8.3 rule (and the checks 8.2 implies). `checkEdl(edl, ctx)` runs them all. The pre-render gate calls the same function. |
| `pieces.ts` | The timeline operations: place shots in beats, snap cuts within what each take covers, merge short shots, split long ones, cut the hook. |
| `words.ts` | Word helpers: cut snapping (word gaps, word edges, beats, frames), caption breaks, the caption-grouping DP, emphasis matching. |
| `geometry.ts` | Caption bands and safe zones as fractions of the frame. |
| `time.ts`, `prng.ts` | Frame grid and the shot-length target; the seed (from the request id) and the mulberry32 generator. |
| `tuning.ts` | The drawable transitions and effects (what the compiler draws) and the caption band type. The 8.2 numbers are in `config/thresholds.ts` (`thresholds.editor`, thresholds@3). |
| `test/inputs.ts` | Test helper: synthetic editor inputs built from a short description. |

`grammar.ts` belongs to W6 and is not in this folder on this branch. The editor reads the grammar from the contract
(`EditGrammar`), so it needs nothing from W6.

## Ports and inputs (the handler)

`jobs/handlers/edit.ts` reads the edit job's inputs: the scene plan, the video DNA, the voice track, the validated request and the
accepted take of each shot. Its ports are `loadStyleKit` (required) and `loadMusic` (optional). Without `loadMusic` the EDL has
no music, and the notes say so.

## Interpretations (lead to confirm)

- Caption size: the grammar's `wordsPerCaption` range is the rule (8.3 says "1 to 3 words, or the grammar's range"). The
  contract always carries the grammar, so the 1-3 default is never used.
- Motion intensity scales the punch-in amplitude: `(intensity + 1) / 4` of the grammar's amplitude. Intensity 0 keeps a small
  move, so the hook's motion rule can always be met.
- The hook's first cut is made by splitting the first shot with a punch-in, so beat boundaries do not move.
- The loop cross-fade is the compiler's 200 ms fade, not the grammar's 500 ms. The compiler has no timing parameter.
- A presenter's face area is assumed in the upper half of a full-frame presenter shot until a face box is measured.
