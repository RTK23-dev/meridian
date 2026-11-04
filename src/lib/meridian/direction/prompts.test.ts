import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_DIRECTION_PROMPTS, DIRECTION_STEPS, directionPrompt, shippedDirectionPrompts } from "./prompts.ts";
import { evidencedScores, parseAnswer, parseJsonText, swipeTestAnswerSchema } from "./answers.ts";
import { HOOK_FAMILY_IDS, FORMAT_IDS, EMOTION_IDS, SHARE_TRIGGER_IDS, REWATCH_DEVICE_IDS, RUBRIC_IDS } from "./codex.ts";

/** A shipped prompt never changes: an edit is a new version with a new pin (Bible 11.3, followed here). */
const PINNED: Record<string, string> = {
  "concept_lab@1": "sha256:28d2915eb2f706458e24480fdd3a201b89fd384e2aac716813fd6e7becccdd37",
  "viewer_panel@1": "sha256:a0911bdf205712255126329aef74ce4950319f21cf1d0d7ef0309a931ebc4437",
  "script_director@1": "sha256:54ca02d1d57417786a79305f78b6532a36f7989cc0803e03d95598c460086fee",
  "swipe_test@1": "sha256:7c90785fa28703d83b322d6dc3d02f55a7369978b88683175cd8ae4906959dc0",
};

test("every shipped direction prompt is pinned to its hash", () => {
  assert.deepEqual(shippedDirectionPrompts().sort(), Object.keys(PINNED).sort());
  for (const [id, hash] of Object.entries(PINNED)) {
    const [step, version] = id.split("@") as [(typeof DIRECTION_STEPS)[number], string];
    assert.equal(directionPrompt(step, Number(version)).hash, hash, `${id} changed: write a new version instead of editing a shipped one`);
  }
});

test("each prompt has the four parts and names itself on its first line", () => {
  for (const step of DIRECTION_STEPS) {
    const prompt = directionPrompt(step);
    assert.equal(prompt.version, CURRENT_DIRECTION_PROMPTS[step]);
    assert.ok(prompt.text.startsWith(`# ${prompt.id}\n`));
    for (const part of ["## Role and rules", "## Reference material", "## Task input", "## Output contract"]) assert.ok(prompt.text.includes(part), `${prompt.id}: ${part}`);
    assert.match(prompt.text, /untrusted-data/, `${prompt.id} says the blocks are data`);
  }
  assert.throws(() => directionPrompt("concept_lab", 9), /No direction prompt concept_lab@9/);
});

test("the ids a prompt lists are exactly the codex's, so the prompt and the contract agree", () => {
  const lab = directionPrompt("concept_lab").text;
  for (const ids of [HOOK_FAMILY_IDS, FORMAT_IDS, EMOTION_IDS, SHARE_TRIGGER_IDS]) assert.ok(lab.includes(ids.join(", ")), ids.join(","));
  assert.ok(directionPrompt("script_director").text.includes(REWATCH_DEVICE_IDS.join(", ")));
  assert.ok(directionPrompt("swipe_test").text.includes(RUBRIC_IDS.join(", ")));
});

test("answers are read as plain, fenced or embedded JSON, and a contract miss names its path", () => {
  assert.deepEqual(parseJsonText('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJsonText('```json\n{"a":2}\n```'), { ok: true, value: { a: 2 } });
  assert.deepEqual(parseJsonText('Sure! {"a":3} Hope this helps.'), { ok: true, value: { a: 3 } });
  assert.equal(parseJsonText("no json at all").ok, false);
  const miss = parseAnswer('{"windows":[],"scores":{},"verdict":"ship","fixes":[]}', swipeTestAnswerSchema);
  assert.equal(miss.ok, false);
  assert.match(miss.ok ? "" : miss.error, /^windows:/);
});

test("a swipe-test score with no evidence counts as 0", () => {
  const scores = evidencedScores({
    windows: [{ fromMs: 0, toMs: 500, beatId: "b1", sees: "s", openQuestion: "q", risk: "low", reason: "r" }],
    scores: { stop_frame: { score: 4, evidence: "b1: motion" }, payoff: { score: 4, evidence: "  " } },
    verdict: "ship",
    fixes: [],
  });
  assert.deepEqual(scores, { stop_frame: 4, payoff: 0 });
});
