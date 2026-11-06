import assert from "node:assert/strict";
import test from "node:test";
import { checkScript, dealCards, exampleRequest, filterAnswers, readRequest, revisionMessage, roleMessage, scriptForUse } from "./agent-tools.ts";
import { STRONG_SCRIPT, WEAK_SCRIPT } from "./fixtures.ts";
import { directionPrompt } from "./prompts.ts";

const REQUEST = exampleRequest();

test("a request file is read with its defaults, and one that does not fit names the field", () => {
  const read = readRequest({ brief: { text: "A brief" }, brand: {}, language: "en", maxDurationMs: 30_000 });
  assert.ok(read.ok);
  assert.deepEqual(read.request.recentHooks, []);
  assert.deepEqual(read.request.brand, { name: "", claims: [], forbidden: [] });
  const bad = readRequest({ brief: { text: "A brief" }, brand: {}, language: "en", maxDurationMs: 999_999 });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /^maxDurationMs:/);
  assert.match(REQUEST.brief.text, /^EXAMPLE ONLY\./, "the example says its facts are invented");
});

test("an agent acting as a role gets the pinned prompt and the same user message a run sends", () => {
  const cards = dealCards({ count: 3, seed: "agent-test", niche: REQUEST.niche });
  assert.deepEqual(cards, dealCards({ count: 3, seed: "agent-test", niche: REQUEST.niche }), "a seed replays its hand");
  const lab = roleMessage({ step: "concept_lab", request: REQUEST, cards });
  assert.equal(lab.promptId, "concept_lab@2");
  assert.equal(lab.system, directionPrompt("concept_lab").text);
  assert.equal(lab.codexVersion, "direction-codex@2");
  assert.match(lab.user, /^Meridian's direction \(trusted, ours\):/);
  assert.match(lab.user, /<untrusted-data name="cards">/);
  const { id: _id, source: _source, ...concept } = { id: "x", source: { family: "a", call: 0 }, hookFamily: STRONG_SCRIPT.hookFamily, format: STRONG_SCRIPT.format, feeling: STRONG_SCRIPT.feeling, topic: "Mugs", coreArgument: "c", evidence: "e", job: "reach" as const, audience: "broad" as const, angle: "a", hook: { picture: "p", text: "t", voice: "v" }, promise: "p", payoff: "p", sendTrigger: STRONG_SCRIPT.sendTrigger, novelty: "n", probability: 0.1 };
  const revision = revisionMessage(REQUEST, concept, STRONG_SCRIPT, "Open on the steam");
  assert.equal(revision.promptId, "script_director@3");
  assert.match(revision.user, /<untrusted-data name="person">\n\{"notes":"Open on the steam"\}/);
  assert.match(revision.user, /<untrusted-data name="draft">/);
});

test("concept-lab answers are filtered as a run filters them, and an answer off the contract is refused", () => {
  const cards = dealCards({ count: 2, seed: "filter", niche: REQUEST.niche });
  const concept = (index: number, words: string[]) => ({
    ...cards[index]!,
    topic: `${words[0]} mug`,
    coreArgument: words.join(" "),
    evidence: "The test",
    job: "reach",
    audience: "broad",
    angle: words.slice(0, 2).join(" "),
    hook: { picture: `${words[2]} in motion`, text: words[3]!, voice: `${words[4]} ${words[0]}` },
    promise: words.slice(1, 3).join(" "),
    payoff: words.slice(3).join(" "),
    sendTrigger: "utility",
    novelty: `${words[0]} ${words[4]}`,
    probability: 0.1,
  });
  const answer = {
    obvious: ["Show the mug on a desk", "List the mug's features", "A customer says it is great"],
    concepts: [concept(0, ["copper", "kettle", "dawn", "spill", "rescue"]), concept(1, ["copper", "kettle", "dawn", "spill", "rescue"])],
  };
  const result = filterAnswers(REQUEST, [answer]);
  assert.ok(result.ok);
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped[0]!.reason, "duplicate");
  const refused = filterAnswers(REQUEST, [{ obvious: [], concepts: [] }]);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /^answer 1: obvious/);
});

test("a script is checked with every check a run applies; a blocked one cannot be used", () => {
  const strong = checkScript(REQUEST, STRONG_SCRIPT);
  assert.ok(strong.ok);
  assert.equal(strong.blocked, false);
  const weak = checkScript(REQUEST, WEAK_SCRIPT);
  assert.ok(weak.ok);
  assert.equal(weak.blocked, true);
  assert.deepEqual(scriptForUse(REQUEST, WEAK_SCRIPT), { ok: false, error: "The script has a blocking finding. Revise it first." });
  const offContract = checkScript(REQUEST, { ...STRONG_SCRIPT, beats: [] });
  assert.equal(offContract.ok, false);
  const used = scriptForUse(REQUEST, STRONG_SCRIPT);
  assert.ok(used.ok);
  assert.deepEqual(used.engineScript.beats[0], { beatId: "b1", role: "hook", text: STRONG_SCRIPT.beats[0]!.voice });
  assert.equal(used.engineScript.language, "en");
  assert.match(used.note, /^Direction for the chosen script \(made in agent mode, direction-codex@2\)/);
});

test("a hook the brand used recently blocks, so agent mode cannot repeat it", () => {
  const checked = checkScript({ ...REQUEST, recentHooks: [STRONG_SCRIPT.beats[0]!.voice] }, STRONG_SCRIPT);
  assert.ok(checked.ok);
  assert.equal(checked.blocked, true);
  assert.equal(checked.report.floors.originality, "fail");
});
