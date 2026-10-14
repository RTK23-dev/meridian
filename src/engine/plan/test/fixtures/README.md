# Plan test fixtures

Recorded role answers for the plan stage, in the shape of the OpenRouter chat completions response with `usage.cost`
(the same shape as `src/engine/claude/test/fixtures/`). Each file is one HTTP response body. The model's answer is the JSON
string in `choices[0].message.content`.

They are authored in that shape for the fixture request (`contracts/fixtures`, the five beats and the $4 budget). They are not
captures of a live call: no agent holds a key (North Star decision 1). The owner's live run replaces them with the recorded
answers.

Shot ids in the planner and director answers are the deterministic ids of `plan/align.ts` (`shotIdFor`). The tests fail if the
ids drift from the shots the code now makes, so a change to the splitting rule shows up here first.

| File | What it stands for |
| --- | --- |
| `openrouter-request-classifier-ok.json` | The classifier's answer for the fixture's one must: the blender is `real_product`. |
| `openrouter-planner-ok.json` | The planner's prompts and queries for the $4 plan: every shot that may be generated, and every stock shot. |
| `openrouter-planner-stock-only.json` | The planner's queries for the $0.52 plan: only the three stock shots need writing. |
| `openrouter-planner-sign.json` | A planner answer whose prompts ask for a sign and a price to be drawn. The answer contract refuses it. |
| `openrouter-director-ok.json` | The director approves the plan with no swaps and no edits. |
| `openrouter-director-swap.json` | A valid swap (a stock shot to a product hero, which is one of its candidates) and an invalid one (the must shot to stock). |
| `openrouter-director-out-of-bounds.json` | Five out-of-bounds swaps (unknown shot, non-candidate, unknown type name, a type the shot already has) and two prompt edits, one valid and one that asks for a sign. |
| `openrouter-director-prose.json` | A director answer with a reason inside a swap. The answer contract refuses it. |

Every answer's `usage.cost` is an example value, not a measured price.
