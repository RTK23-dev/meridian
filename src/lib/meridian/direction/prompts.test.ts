import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_DIRECTION_PROMPTS, DIRECTION_STEPS, directionPrompt, shippedDirectionPrompts } from "./prompts.ts";
import { evidencedScores, parseAnswer, parseJsonText, swipeTestAnswerSchema } from "./answers.ts";
import { EMOTION_IDS, FORMAT_IDS, FUNNEL_BLOCKERS, HOOK_FAMILY_IDS, LOCK_IN_APPROACHES, REWATCH_DEVICE_IDS, RUBRIC_IDS, SHARE_TRIGGER_IDS, TRUST_ANCHOR_TYPES, VIDEO_JOBS, VILLAIN_TYPES } from "./codex.ts";

/** A shipped prompt never changes: an edit is a new version with a new pin (Bible 11.3, followed here). */
const PINNED: Record<string, string> = {
  "concept_lab@2": "sha256:0d686dc7e15bb3ce515f0a00fa71ada6956131aba4138ab283e248b22f622e8a",
  "viewer_panel@2": "sha256:53ea7ff4db7b3069f608fb53e4872ac4ade041a0265db4c409010f1b5d948685",
  "script_director@2": "sha256:99d9b977c796b2908887ac0b69e38a95f940c7e54f2d63121cb20bc4062d36b6",
  "swipe_test@2": "sha256:4899aa25b9cae6d9f94e266366dc822cacf0678a10f0881df3d42b8f2fafef78",
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
  for (const ids of [HOOK_FAMILY_IDS, FORMAT_IDS, EMOTION_IDS, SHARE_TRIGGER_IDS, VIDEO_JOBS]) assert.ok(lab.includes(ids.join(", ")), ids.join(","));
  const director = directionPrompt("script_director").text;
  for (const ids of [REWATCH_DEVICE_IDS, LOCK_IN_APPROACHES, TRUST_ANCHOR_TYPES, VILLAIN_TYPES]) assert.ok(director.includes(ids.join(", ")), ids.join(","));
  const swipe = directionPrompt("swipe_test").text;
  assert.ok(swipe.includes(RUBRIC_IDS.join(", ")));
  assert.ok(swipe.includes(FUNNEL_BLOCKERS.join(", ")));
});

test("the version 2 prompts carry the lessons a model must follow", () => {
  const lab = directionPrompt("concept_lab").text;
  assert.match(lab, /like a lawyer/);
  assert.match(lab, /triple hook/);
  assert.match(lab, /one degree away/);
  const director = directionPrompt("script_director").text;
  assert.match(director, /core template: hook, lock-in/);
  assert.match(director, /within 15 seconds/);
  assert.match(director, /zig-zag/);
  assert.match(director, /trust anchor is proof the brief gives/);
  assert.match(directionPrompt("viewer_panel").text, /send what surprises you/);
  assert.match(directionPrompt("swipe_test").text, /"expectation"/);
  assert.match(lab, /clip_stitch hook opens on up to five seconds of another creator's clip that the brief or the trends name/);
  assert.match(director, /A clip-stitch opening: the first beat is the borrowed clip/);
});

test("answers are read as plain, fenced or embedded JSON, and a contract miss names its path", () => {
  assert.deepEqual(parseJsonText('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJsonText('```json\n{"a":2}\n```'), { ok: true, value: { a: 2 } });
  assert.deepEqual(parseJsonText('Sure! {"a":3} Hope this helps.'), { ok: true, value: { a: 3 } });
  assert.equal(parseJsonText("no json at all").ok, false);
  const miss = parseAnswer('{"windows":[],"scores":{},"blocker":"none","verdict":"ship","fixes":[]}', swipeTestAnswerSchema);
  assert.equal(miss.ok, false);
  assert.match(miss.ok ? "" : miss.error, /^windows:/);
});

test("a swipe-test score with no evidence counts as 0", () => {
  const scores = evidencedScores({
    windows: [{ fromMs: 0, toMs: 500, beatId: "b1", sees: "s", openQuestion: "q", expectation: "better", risk: "low", reason: "r" }],
    scores: { stop_frame: { score: 4, evidence: "b1: motion" }, payoff: { score: 4, evidence: "  " } },
    blocker: "none",
    verdict: "ship",
    fixes: [],
  });
  assert.deepEqual(scores, { stop_frame: 4, payoff: 0 });
});
