# Claude client fixtures

Recorded OpenRouter answers for the W3 client, in the shape of the OpenRouter chat completions response with `usage.cost`
(the same shape as `src/engine/gateway/test/fixtures/openrouter-chat.json`). Each file is one HTTP response body, and the
model's answer is the JSON string in `choices[0].message.content`.

These are authored fixtures in that shape. They are not captures of a live call: no agent holds a key (North Star decision
1). The owner's live run (see `../../STATUS.md`) replaces them with the recorded answers, and the golden test then runs
against those.

| File | What it stands for |
| --- | --- |
| `segmenter-input.json` | A 12-second example: two cuts, six words, three frames (1x1 PNG placeholders). |
| `openrouter-segmenter-ok.json` | A good answer: three segments, valid word ids, with `usage.cost`. |
| `openrouter-segmenter-ok-no-cost.json` | The same kind of answer with no `usage.cost` (the ledger must hold the estimate). |
| `openrouter-segmenter-overlap.json` | An answer with an unknown word id, an overlap and a segment past the video's end. |
| `openrouter-segmenter-enum.json` | An answer with a shot type outside the enum. Its marker text must never reach a retry. |
| `openrouter-segmenter-prose.json` | An answer that is prose, not JSON. |

Every answer's `usage.cost` is an example value, not a measured price.
