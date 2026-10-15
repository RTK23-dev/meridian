// The analyze_reference pipeline on recorded measurements and recorded role answers (Bible 6.2, acceptance in 19 E3). The
// measurements are captured from the real probe, cuts and timeline functions on a generated reel (test/fixtures/README.md).
// The transcript, the captions, zoom and loop readings are synthetic and labelled so. No test calls a live API.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOW, RESERVATION_ID } from "../claude/test/helpers.ts";
import { videoDnaSchema } from "../contracts/analysis.ts";
import {
  DNA_ID,
  copiesGenomeBody,
  genomeBody,
  recordedMedia,
  recordedPictureReadings,
  referencePorts as portsFor,
  referenceRun as run,
  request,
  segmenterBody,
  segmenterWithLayer,
} from "./test/harness.ts";
import { analyzeReference } from "./reference.ts";

describe("analyze_reference on recorded measurements and role answers", () => {
  it("passes the dna gate, builds a valid VideoDNA, and releases the source", async () => {
    const { ports, requests, released } = await portsFor({
      responses: [segmenterBody, genomeBody],
    });
    const outcome = await analyzeReference(run(), ports);

    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    const failing = outcome.gate.checks.filter((check) => !check.pass);
    assert.deepEqual(failing, [], `gate checks that failed: ${JSON.stringify(failing)}`);
    assert.equal(outcome.gate.pass, true);
    assert.deepEqual(outcome.unknown, []);
    assert.ok(outcome.dna, "the DNA is built when the gate passes");
    const dna = outcome.dna;
    assert.equal(videoDnaSchema.safeParse(dna).success, true);

    assert.equal(dna.videoDnaId, DNA_ID);
    assert.equal(dna.formatId, request.format.formatId);
    assert.equal(dna.durationMs, 6000);
    assert.equal(dna.segments.length, 4);
    assert.equal(dna.sourceDeletedAt, NOW, "sourceDeletedAt is the time the source was released");
    assert.deepEqual(
      released,
      [request.format.referenceVideo],
      "the source is released exactly once",
    );
    assert.equal(requests.length, 2, "the segmenter and the genome are each called once");
  });

  it("gives every segment its measured motion, brightness and loudness, all finite", async () => {
    const { ports } = await portsFor({ responses: [segmenterBody, genomeBody] });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done" || !outcome.dna) return;
    for (const segment of outcome.dna.segments) {
      assert.ok(Number.isFinite(segment.motion) && segment.motion >= 0 && segment.motion <= 1);
      assert.ok(
        Number.isFinite(segment.brightness) && segment.brightness >= 0 && segment.brightness <= 1,
      );
      assert.ok(Number.isFinite(segment.loudnessLufs));
    }
  });

  it("matches the hand labels: the first cut within two frames, and shot length within 10 per cent", async () => {
    const { ports } = await portsFor({ responses: [segmenterBody, genomeBody] });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done" || !outcome.dna) return;
    const grammar = outcome.dna.editGrammar;
    // The reel's cuts are at 1500, 3000 and 4500 ms. Two frames at 30 fps is 67 ms.
    assert.ok(
      Math.abs(grammar.hookFirstCutMs - 1500) <= 2 * (1000 / 30),
      `first cut ${grammar.hookFirstCutMs} ms`,
    );
    assert.ok(
      Math.abs(grammar.shotLengthMs.p50 - 1500) / 1500 <= 0.1,
      `median shot ${grammar.shotLengthMs.p50} ms`,
    );
    assert.equal(grammar.captions.wordsPerCaption[0], 2);
    assert.equal(grammar.captions.wordsPerCaption[1], 3);
  });

  it("takes the genome from the recorded answer, and keeps the transferable genes", async () => {
    const { ports } = await portsFor({ responses: [segmenterBody, genomeBody] });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done" || !outcome.dna) return;
    assert.equal(outcome.dna.genome.hook_mechanism, "result-first");
    assert.deepEqual(outcome.dna.transferable, ["hook_mechanism", "pacing", "caption_style"]);
    assert.deepEqual(outcome.dna.notTransferable, ["footage", "voice", "music"]);
  });

  it("uses the recorded transcript for segmentation and stores it; the speech-to-text call is metered once", async () => {
    const { ports, stt } = await portsFor({ responses: [segmenterBody, genomeBody] });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done" || !outcome.dna) return;
    assert.deepEqual(
      outcome.dna.transcript.words.map((word) => word.text),
      ["watch", "this", "blender", "crush", "ice", "fast", "tap", "link"],
    );
    assert.equal(stt.calls.length, 1);
  });

  it("fails closed before any spend when speech-to-text is not connected", async () => {
    const { ports, requests, released, resolved, ledger } = await portsFor({
      responses: [segmenterBody],
      speechConnected: false,
    });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "not_connected");
    if (outcome.status !== "not_connected") return;
    assert.match(outcome.reason, /^NOT_CONNECTED:/);
    assert.equal(requests.length, 0, "no model call");
    assert.equal(resolved.length, 0, "the reference is not even fetched");
    assert.equal(released.length, 0);
    assert.equal(
      (await ledger.listEntries(RESERVATION_ID)).length,
      0,
      "nothing is written to the ledger",
    );
  });

  it("fails the gate, names the missing readings, and still releases the source, when no caption or zoom reader is connected", async () => {
    const { ports, released } = await portsFor({
      responses: [segmenterBody, genomeBody],
      readings: null,
    });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(outcome.gate.pass, false);
    assert.equal(outcome.dna, null, "no DNA is stored with an unknown field");
    const text = outcome.unknown.join("\n");
    assert.match(text, /captions/);
    assert.match(text, /zoom/);
    assert.match(text, /loop/);
    assert.equal(released.length, 1, "the source is released on the failure path too");
  });

  it("reads zoom and loop from the picture measures; the gate still fails, naming only the captions and the motion it cannot read", async () => {
    const { ports, released } = await portsFor({
      responses: [segmenterBody, genomeBody],
      readingsPort: recordedPictureReadings("punch"),
    });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(outcome.gate.pass, false);
    assert.equal(outcome.dna, null, "no DNA is stored with an unknown field");
    const text = outcome.unknown.join("\n");
    assert.match(text, /captions/);
    assert.match(text, /^motion \(shakeOnImpact/m);
    assert.doesNotMatch(text, /zoom \(/, "the zoom reading is measured");
    assert.doesNotMatch(text, /loop \(/, "the loop reading is measured");
    assert.equal(released.length, 1);
  });

  it("refuses a segment layer that repeats the transcript, so no source words enter the DNA through a layer", async () => {
    const { ports } = await portsFor({
      responses: [segmenterWithLayer("watch this blender crush ice"), genomeBody],
    });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(outcome.gate.pass, false);
    assert.ok(
      outcome.gate.checks.some((check) => check.rule === "no_copied_content" && !check.pass),
    );
    assert.equal(outcome.dna, null);
  });

  it("retries a genome answer that copies the transcript once, and stores the valid answer that follows", async () => {
    const { ports, requests } = await portsFor({
      responses: [segmenterBody, copiesGenomeBody, genomeBody],
    });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done" || !outcome.dna) return;
    assert.equal(requests.length, 3, "the copying answer is retried once");
    assert.equal(outcome.dna.genome.hook_mechanism, "result-first");
    assert.equal(outcome.gate.pass, true);
  });

  it("stores no source words beyond the transcript: no three-word run of it appears in any other stored field", async () => {
    const { ports } = await portsFor({ responses: [segmenterBody, genomeBody] });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done" || !outcome.dna) return;
    const { transcript, ...rest } = outcome.dna;
    const words = transcript.words.map((word) => word.text.toLowerCase());
    const stored = JSON.stringify(rest).toLowerCase();
    const runs = new Set<string>();
    for (let index = 0; index + 3 <= words.length; index++)
      runs.add(words.slice(index, index + 3).join(" "));
    for (const phrase of runs)
      assert.equal(stored.includes(phrase), false, `"${phrase}" is stored outside the transcript`);
    assert.equal(
      stored.includes("watch this"),
      false,
      "the segmenter's on-screen text is not stored",
    );
  });

  it("refuses an example with no audio: the audio and the segment measures fail, and the genome is not called", async () => {
    const { ports, requests } = await portsFor({
      responses: [segmenterBody],
      media: recordedMedia({ audio: false }),
    });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(outcome.gate.pass, false);
    assert.ok(outcome.gate.checks.some((check) => check.rule === "audio_measured" && !check.pass));
    assert.equal(requests.length, 1, "only the segmenter runs");
    assert.equal(outcome.dna, null);
  });

  it("fails the gate, with no model call, when the duration cannot be measured", async () => {
    const { ports, requests, released } = await portsFor({
      responses: [],
      media: recordedMedia({ durationMs: null }),
    });
    const outcome = await analyzeReference(run(), ports);
    assert.equal(outcome.status, "done");
    if (outcome.status !== "done") return;
    assert.equal(outcome.gate.pass, false);
    assert.equal(requests.length, 0);
    assert.equal(released.length, 1);
  });
});
