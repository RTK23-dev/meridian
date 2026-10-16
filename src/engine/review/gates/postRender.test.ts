import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../../config/thresholds.ts";
import { FINAL_RUBRIC_ITEMS } from "../../claude/roles/critic_final.ts";
import { decideGate } from "../gold.ts";
import {
  VIDEO_ID,
  answeredCritic,
  cleanPostRenderInput,
  cleanRender,
  integrityPassed,
  provenMetrics,
  unprovenMetrics,
  type CleanRender,
} from "../test/render.ts";
import { checkPostRender, criticFrameTimes, criticGoldMetricsByCheck, requiredFrameTimes, shotAt, type PostRenderInput } from "./postRender.ts";
import { shotIdOf } from "../../edit/rules.ts";
import type { EditDecisionList } from "../../contracts/index.ts";

function check(result: { gate: { checks: { rule: string; pass: boolean; detail?: string; value?: number }[] } }, rule: string) {
  const found = result.gate.checks.find((item) => item.rule === rule);
  assert.ok(found, `no check ${rule}`);
  return found;
}

function withInput(render: CleanRender, change: Partial<PostRenderInput>): PostRenderInput {
  return { ...cleanPostRenderInput(render), ...change };
}

/** The first graphics clip of the clean EDL, and the shot it belongs to. */
function firstGraphics(edl: EditDecisionList) {
  const clip = edl.tracks.find((track) => track.layer === "graphics")?.clips[0];
  if (!clip) throw new Error("the clean EDL has no graphics clip");
  return { clip, shotId: shotIdOf(clip.clipId) };
}

describe("post_render gate: a clean video passes (Bible 12.3)", () => {
  it("every measured check passes, so the review result has no failures and the gate passes", () => {
    const outcome = checkPostRender(cleanPostRenderInput());
    assert.equal(outcome.gate.gate, "post_render");
    assert.equal(outcome.gate.subjectId, VIDEO_ID);
    assert.equal(outcome.gate.pass, true, outcome.gate.checks.filter((item) => !item.pass).map((item) => item.rule).join(", "));
    assert.deepEqual(outcome.failures, []);
    assert.equal(decideGate(outcome.gate, {}).verdict, "pass");
  });
});

describe("post_render gate: a broken overlay never passes (Bible 12.3 acceptance)", () => {
  it("an overlay missing from its frame fails the gate, names the shot and the graphics layer", () => {
    const render = cleanRender();
    const { clip, shotId } = firstGraphics(render.edl);
    const overlays = [{ clipId: clip.clipId, present: false }, ...(cleanPostRenderInput(render).overlays ?? []).filter((item) => item.clipId !== clip.clipId)];
    const outcome = checkPostRender(withInput(render, { overlays }));
    assert.equal(outcome.gate.pass, false);
    assert.equal(check(outcome, "overlays_present").pass, false);
    assert.ok(outcome.gate.failingShotIds?.includes(shotId), "the shot with the broken overlay is named");
    assert.ok(outcome.failures.some((item) => item.rule === "overlays_present" && item.layer === "graphics" && item.shotId === shotId));
  });

  it("with no gold set the broken overlay goes to review; with a proven set it blocks; it never passes either way", () => {
    const render = cleanRender();
    const { clip } = firstGraphics(render.edl);
    const overlays = (cleanPostRenderInput(render).overlays ?? []).map((item) => (item.clipId === clip.clipId ? { ...item, present: false } : item));
    const outcome = checkPostRender(withInput(render, { overlays }));
    assert.equal(decideGate(outcome.gate, {}).verdict, "review");
    assert.equal(decideGate(outcome.gate, { "post_render:overlays_present": provenMetrics() }).verdict, "block");
    assert.equal(decideGate(outcome.gate, { "post_render:overlays_present": unprovenMetrics() }).verdict, "review");
    assert.equal(outcome.gate.pass, false);
  });

  it("an overlay the frames could not show (null) or that was not measured at all never passes", () => {
    const render = cleanRender();
    const { clip } = firstGraphics(render.edl);
    const unknown = checkPostRender(
      withInput(render, { overlays: (cleanPostRenderInput(render).overlays ?? []).map((item) => (item.clipId === clip.clipId ? { ...item, present: null } : item)) }),
    );
    assert.equal(unknown.gate.pass, false);
    const absent = checkPostRender(withInput(render, { overlays: undefined }));
    assert.equal(absent.gate.pass, false);
    assert.match(check(absent, "overlays_present").detail ?? "", /not evaluated/);
    const missingOne = checkPostRender(withInput(render, { overlays: (cleanPostRenderInput(render).overlays ?? []).filter((item) => item.clipId !== clip.clipId) }));
    assert.equal(missingOne.gate.pass, false, "a graphics clip with no measurement is not a pass");
  });

  it("an EDL with no graphics layer has no overlay to check, so that check passes without a measurement", () => {
    const render = cleanRender();
    const edl = structuredClone(render.edl);
    edl.tracks = edl.tracks.filter((track) => track.layer !== "graphics");
    const outcome = checkPostRender(withInput(render, { edl, renderedVideo: { ...render.rendered, durationMs: edl.durationMs }, overlays: undefined, blackFrames: undefined }));
    assert.equal(check(outcome, "overlays_present").pass, true);
  });
});

describe("post_render gate: the render integrity result is evidence, and missing evidence is review", () => {
  it("a missing render_integrity result fails the check and goes to review, never to pass", () => {
    const outcome = checkPostRender(withInput(cleanRender(), { integrity: undefined }));
    assert.equal(outcome.gate.pass, false);
    assert.match(check(outcome, "render_integrity_passed").detail ?? "", /missing evidence/);
    assert.equal(decideGate(outcome.gate, {}).verdict, "review");
    assert.ok(outcome.failures.some((item) => item.rule === "render_integrity_passed"));
  });

  it("a render_integrity result that failed fails the gate", () => {
    const failed = { ...integrityPassed(), pass: false, checks: [{ rule: "fps", pass: false }] };
    const outcome = checkPostRender(withInput(cleanRender(), { integrity: failed }));
    assert.equal(check(outcome, "render_integrity_passed").pass, false);
    assert.match(check(outcome, "render_integrity_passed").detail ?? "", /fps/);
  });

  it("a passing integrity result for another video is not evidence for this one", () => {
    const outcome = checkPostRender(withInput(cleanRender(), { integrity: integrityPassed("vid_01JABCDEFGHJKMNPQRSTVWXYZ9") }));
    assert.equal(check(outcome, "render_integrity_passed").pass, false);
    assert.match(check(outcome, "render_integrity_passed").detail ?? "", /another render/);
  });

  it("an integrity result that does not parse fails the check", () => {
    const outcome = checkPostRender(withInput(cleanRender(), { integrity: { gate: "render_integrity" } }));
    assert.equal(check(outcome, "render_integrity_passed").pass, false);
  });
});

describe("post_render gate: audio (Bible 8.2 step 11, 12.3)", () => {
  it("loudness outside -14 LUFS plus or minus one fails, and an unmeasured loudness is not evaluated", () => {
    const quiet = checkPostRender(withInput(cleanRender(), { loudness: { integratedLufs: -16, truePeakDbtp: -2 } }));
    assert.equal(check(quiet, "loudness_within_tolerance").pass, false);
    const unmeasured = checkPostRender(withInput(cleanRender(), { loudness: { integratedLufs: null, truePeakDbtp: -2 } }));
    assert.equal(check(unmeasured, "loudness_within_tolerance").pass, false);
    assert.match(check(unmeasured, "loudness_within_tolerance").detail ?? "", /not evaluated/);
  });

  it("a true peak above -1 dBTP fails (clipping), and an unmeasured peak fails", () => {
    const hot = checkPostRender(withInput(cleanRender(), { loudness: { integratedLufs: -14, truePeakDbtp: -0.4 } }));
    assert.equal(check(hot, "true_peak_within_limit").pass, false);
    assert.equal(thresholds.postRender.truePeakMaxDbtp, -1);
    const unmeasured = checkPostRender(withInput(cleanRender(), { loudness: { integratedLufs: -14, truePeakDbtp: null } }));
    assert.equal(check(unmeasured, "true_peak_within_limit").pass, false);
  });

  it("silence over the limit fails, and a silence that was not measured is not evaluated", () => {
    const long = checkPostRender(withInput(cleanRender(), { silence: { longestMs: thresholds.postRender.silenceMaxMs.value + 1 } }));
    assert.equal(check(long, "silence_within_limit").pass, false);
    const unknown = checkPostRender(withInput(cleanRender(), { silence: undefined }));
    assert.equal(unknown.gate.pass, false);
  });
});

describe("post_render gate: frames at the cuts and the sample positions (Bible 6.12, 12.3)", () => {
  it("a black frame at a cut fails the check and names the shot on screen at that time", () => {
    const render = cleanRender();
    const cut = render.edl.tracks.find((track) => track.layer === "base")?.clips[0];
    assert.ok(cut);
    const blackFrames = (cleanPostRenderInput(render).blackFrames ?? []).map((item) => (item.atMs === cut.startMs ? { ...item, black: true } : item));
    const outcome = checkPostRender(withInput(render, { blackFrames }));
    assert.equal(check(outcome, "black_frames_absent").pass, false);
    assert.ok(outcome.gate.failingShotIds?.includes(shotIdOf(cut.clipId)));
  });

  it("a required frame that was not measured is not a pass", () => {
    const render = cleanRender();
    const blackFrames = (cleanPostRenderInput(render).blackFrames ?? []).slice(1);
    const outcome = checkPostRender(withInput(render, { blackFrames }));
    assert.equal(check(outcome, "black_frames_absent").pass, false);
    assert.match(check(outcome, "black_frames_absent").detail ?? "", /not measured/);
  });

  it("the required times are the sample positions and the cut times plus or minus two frames, inside the video", () => {
    const render = cleanRender();
    const times = requiredFrameTimes(render.edl);
    for (const position of thresholds.postRender.samplePositions) {
      assert.ok(times.includes(Math.round(position * render.edl.durationMs)), `the ${position} sample is required`);
    }
    const cut = render.edl.tracks.find((track) => track.layer === "base")?.clips[1]?.startMs ?? 0;
    assert.ok(times.some((time) => Math.abs(time - cut) <= 67), "frames around the cut are required");
    assert.deepEqual(times, [...new Set(times)].sort((a, b) => a - b), "ascending and unique");
    assert.ok(times.every((time) => time >= 0 && time < render.edl.durationMs));
  });

  it("the final Critic sees twelve frames spread over the whole video, ascending and inside it", () => {
    const times = criticFrameTimes(24000);
    assert.equal(times.length, thresholds.postRender.criticFinalFrames);
    assert.ok(times.every((time, index) => index === 0 || time > (times[index - 1] ?? -1)));
    assert.ok(times[0] !== undefined && times[0] < 2000 && (times[11] ?? 0) > 22000);
    assert.deepEqual(criticFrameTimes(5), [], "a video too short for twelve frames gives none");
  });

  it("shotAt names the shot whose picture covers a time, and null in a gap", () => {
    const render = cleanRender();
    const clip = render.edl.tracks.find((track) => track.layer === "base")?.clips[0];
    assert.ok(clip);
    assert.equal(shotAt(render.edl, clip.startMs), shotIdOf(clip.clipId));
    assert.equal(shotAt(render.edl, render.edl.durationMs + 5000), null);
  });
});

describe("post_render gate: OCR of the captions and the claims on screen (Bible 12.3)", () => {
  it("captions read from the frames that do not match the script fail", () => {
    const outcome = checkPostRender(withInput(cleanRender(), { ocr: { captionWordsChecked: 24, captionWordsMismatched: 2, onScreenText: [] } }));
    assert.equal(check(outcome, "captions_ocr_match_script").pass, false);
  });

  it("captions that were not read from the frames are not evaluated", () => {
    const outcome = checkPostRender(withInput(cleanRender(), { ocr: undefined }));
    assert.equal(check(outcome, "captions_ocr_match_script").pass, false);
    assert.match(check(outcome, "captions_ocr_match_script").detail ?? "", /not evaluated/);
    assert.equal(check(outcome, "forbidden_terms_absent").pass, false, "the text on screen was not read either");
  });

  it("a forbidden term read from the screen fails, whatever its case", () => {
    const outcome = checkPostRender(
      withInput(cleanRender(), { ocr: { captionWordsChecked: 24, captionWordsMismatched: 0, onScreenText: ["A MIRACLE CURE for every kitchen"] } }),
    );
    assert.equal(check(outcome, "forbidden_terms_absent").pass, false);
  });

  it("a forbidden term in the EDL's own text fails, as a whole word and not inside another word", () => {
    const render = cleanRender();
    const inText = checkPostRender(withInput(render, { forbiddenTerms: ["blend"] }));
    assert.equal(check(inText, "forbidden_terms_absent").pass, false, "BLEND is in the cta card's text");
    const inside = checkPostRender(withInput(render, { forbiddenTerms: ["blen"] }));
    assert.equal(check(inside, "forbidden_terms_absent").pass, true, "a fragment of a word is not the term");
  });

  it("no forbidden terms known is not evaluated", () => {
    const outcome = checkPostRender(withInput(cleanRender(), { forbiddenTerms: undefined }));
    assert.equal(check(outcome, "forbidden_terms_absent").pass, false);
  });
});

describe("post_render gate: the final Critic (Bible 12.3, 12.4)", () => {
  it("the nine rubric items are checks of their own, each against the configured floor", () => {
    const outcome = checkPostRender(cleanPostRenderInput());
    for (const item of FINAL_RUBRIC_ITEMS) {
      assert.equal(check(outcome, `rubric_${item}`).pass, true, item);
    }
  });

  it("a rubric item below the floor fails with its score, and only that check's gold set can block it", () => {
    const critic = answeredCritic();
    const hurt = { ...critic, rubric: { ...critic.rubric, hands: 0.4 } };
    const outcome = checkPostRender(withInput(cleanRender(), { critic: hurt }));
    assert.equal(check(outcome, "rubric_hands").pass, false);
    assert.equal(check(outcome, "rubric_hands").value, 0.4);
    assert.equal(check(outcome, "rubric_faces").pass, true);
    assert.equal(decideGate(outcome.gate, {}).verdict, "review");
    const proven = decideGate(outcome.gate, criticGoldMetricsByCheck(provenMetrics()));
    assert.equal(proven.verdict, "block");
    assert.deepEqual(proven.provenFailures, ["post_render:rubric_hands"]);
  });

  it("the final Critic's confidence below the escalation threshold fails the check, and it can only escalate", () => {
    const outcome = checkPostRender(withInput(cleanRender(), { critic: answeredCritic(0.9, 0.5, "sonnet") }));
    assert.equal(check(outcome, "critic_confidence").pass, false);
    assert.match(check(outcome, "critic_confidence").detail ?? "", /unsure/);
    assert.equal(decideGate(outcome.gate, criticGoldMetricsByCheck(provenMetrics())).verdict, "review", "the rubric passed, and confidence has no gold set, so nothing can block");
    assert.equal(decideGate(outcome.gate, {}).verdict, "review");
  });

  it("a Critic that gave no answer is missing evidence: one row names the gap, and a proven critic gold set cannot block on it", () => {
    const outcome = checkPostRender(withInput(cleanRender(), { critic: { status: "not_answered", reason: "the final Critic call was refused" } }));
    assert.equal(outcome.gate.pass, false);
    assert.equal(check(outcome, "critic_final_answered").pass, false);
    assert.equal(outcome.gate.checks.some((item) => item.rule.startsWith("rubric_")), false, "no rubric rows that share the gold set's names");
    assert.equal(decideGate(outcome.gate, criticGoldMetricsByCheck(provenMetrics())).verdict, "review");
  });

  it("the one critic gold set is mapped to every rubric rule, and to no other check", () => {
    const metrics = provenMetrics();
    const byCheck = criticGoldMetricsByCheck(metrics);
    assert.equal(Object.keys(byCheck).length, FINAL_RUBRIC_ITEMS.length);
    for (const item of FINAL_RUBRIC_ITEMS) {
      assert.equal(byCheck[`post_render:rubric_${item}`], metrics);
    }
    assert.equal(byCheck["post_render:overlays_present"], undefined);
  });
});

describe("post_render gate: the result is well formed", () => {
  it("the review failures are empty exactly when the gate passes", () => {
    const passing = checkPostRender(cleanPostRenderInput());
    assert.equal(passing.gate.pass, true);
    assert.deepEqual(passing.failures, []);
    const failing = checkPostRender(withInput(cleanRender(), { silence: { longestMs: 5000 } }));
    assert.equal(failing.gate.pass, false);
    assert.ok(failing.failures.length > 0);
  });

  it("an unparsed rendered video or EDL fails the schema check", () => {
    const outcome = checkPostRender(withInput(cleanRender(), { renderedVideo: { videoId: "x" } }));
    assert.equal(outcome.gate.pass, false);
    assert.equal(outcome.gate.checks[0]?.rule, "schema_valid");
  });
});
