import assert from "node:assert/strict";
import test from "node:test";
import { lexiconHits, normalizeText, slopFindings } from "./slop.ts";
import { STRONG_SCRIPT, WEAK_SCRIPT } from "./fixtures.ts";

test("a script that follows the framework has no slop findings", () => {
  assert.deepEqual(slopFindings(STRONG_SCRIPT.beats, "en"), []);
});

test("a first draft's preamble, register, bait and outro are each found, on their beat", () => {
  const findings = slopFindings(WEAK_SCRIPT.beats, "en");
  const of = (check: string) => findings.filter((finding) => finding.check === check);

  assert.deepEqual(
    of("preamble").map((finding) => [finding.beatId, finding.phrase, finding.severity]),
    [
      ["b1", "hey guys", "block"],
      ["b1", "welcome back", "block"],
    ],
  );
  assert.ok(of("slop_lexicon").some((finding) => finding.phrase === "fast-paced world" && finding.beatId === "b1"));
  assert.ok(of("slop_lexicon").some((finding) => finding.phrase === "game-changer"));
  assert.ok(of("slop_lexicon").some((finding) => finding.phrase === "delve" && finding.beatId === "b2"));
  assert.ok(of("slop_lexicon").some((finding) => finding.phrase === "elevate"));
  assert.deepEqual(of("not_x_but_y").map((finding) => finding.beatId), ["b2"]);
  assert.deepEqual(
    of("engagement_bait").map((finding) => [finding.beatId, finding.phrase, finding.severity]),
    [
      ["b4", "comment yes", "block"],
      ["b4", "tag a friend", "block"],
    ],
  );
  assert.deepEqual(
    of("outro").map((finding) => finding.phrase),
    ["thanks for watching", "follow for more"],
  );
});

test("a preamble phrase after the first beat is a warning, not a block", () => {
  const findings = slopFindings(
    [
      { beatId: "b1", role: "hook", voice: "Three mugs. One winner." },
      { beatId: "b2", role: "setup", voice: "Let's get started with the test." },
    ],
    "en",
  );
  assert.deepEqual(
    findings.map((finding) => [finding.check, finding.severity]),
    [["preamble", "warn"]],
  );
});

test("phrases match whole words, case and curly quotes aside, and not inside other words", () => {
  assert.equal(normalizeText("It’s  important"), "It's important");
  assert.deepEqual(lexiconHits("You WON’T believe this").map((hit) => hit.phrase), ["you won't believe"]);
  assert.deepEqual(lexiconHits("The undelivered parcel"), [], "'delve' is not found inside another word");
  assert.deepEqual(lexiconHits("A robustness test"), [], "'robust' is not found inside 'robustness'");
});

test("the not-X-but-Y turn is found in its common forms and not in a plain negative", () => {
  const check = (voice: string) => slopFindings([{ beatId: "b1", role: "hook", voice }], "en").some((finding) => finding.check === "not_x_but_y");
  assert.ok(check("It's not a mug, it's a ritual."));
  assert.ok(check("This isn't about speed. It's about heat."));
  assert.ok(check("That is not just coffee — it's a habit."));
  assert.equal(check("It's not hot after an hour."), false);
});

test("long dashes in voice lines are counted against the length of the script", () => {
  const findings = slopFindings([{ beatId: "b1", role: "hook", voice: "Hot — then cold — then gone." }], "en");
  assert.deepEqual(findings.map((finding) => finding.check), ["dash_density"]);
});

test("a script in another language is not checked, and the report says so instead of passing it", () => {
  const findings = slopFindings([{ beatId: "b1", role: "hook", voice: "Hey guys, willkommen zurück" }], "de");
  assert.deepEqual(findings.map((finding) => [finding.check, finding.severity]), [["slop_lexicon", "info"]]);
  assert.match(findings[0]?.message ?? "", /English only/);
});
