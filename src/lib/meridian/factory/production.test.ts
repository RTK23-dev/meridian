import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { videoEngineById } from "../video/engine.ts";
import {
  ASPECT_RATIOS,
  renderTimelineToVideo,
} from "./render.ts";
import { templateFromDna, variantMatrix } from "./template.ts";
import { dnaFromTranscript } from "./creative-dna.ts";
import { compareOriginalityAgainstSource } from "./gates.ts";

test("Production Step 5: second VideoEngine adapter (timeline) is available and functional", async () => {
  const engine = videoEngineById("timeline");
  assert.equal(engine.id, "timeline");
  const status = engine.status();
  assert.equal(status.status, "CONFIGURED");
  assert.equal(status.provider, "timeline");

  const contract = {
    creativeId: "creative-test-1",
    meridianJobId: "job-1",
    aspectRatio: "9:16",
    durationMs: 6000,
    prompt: "A fresh serum drops onto skin",
  } as any;

  const submit = await engine.submit(contract, {} as any);
  assert.equal(submit.ok, true);
  assert.equal(submit.job?.providerJobId, "timeline_job-1");

  const poll = await engine.poll(submit.job!.providerJobId, {} as any);
  assert.equal(poll.ok, true);
  assert.equal(poll.job?.status, "succeeded");

  const artifact = await engine.collect(submit.job!.providerJobId, {} as any);
  assert.equal(artifact.ok, true);
  assert.equal(artifact.artifact?.mime, "video/mp4");
  assert.ok(artifact.artifact!.bytes.byteLength > 0);
});

test("Production Step 5: variant matrix produces permutations within bound", () => {
  const matrix = variantMatrix({
    hooks: ["Stop scrolling", "Did you know?", "Watch this"],
    ctas: ["Shop now", "Get 20% off"],
    presenters: ["Founder", "Dermatologist"],
    lengthsMs: [9000, 15000],
    max: 12,
  });

  assert.equal(matrix.length, 12);
  assert.ok(matrix.every((v) => v.hook && v.cta && v.presenter && v.lengthMs >= 9000));
  // Checks first entry
  assert.equal(matrix[0]?.hook, "Stop scrolling");
  assert.equal(matrix[0]?.cta, "Shop now");
  assert.equal(matrix[0]?.presenter, "Founder");
  assert.equal(matrix[0]?.lengthMs, 9000);
});

test("Production Step 5: timeline renderer builds compositions across 9:16, 4:5, 1:1, and 16:9", () => {
  const dna = dnaFromTranscript({
    adId: "winner-1",
    durationMs: 12000,
    transcript: "Say goodbye to dry skin. Clinically proven hydrating formula. Order yours today.",
  });
  const template = templateFromDna(dna);

  const variant = {
    hook: "Say goodbye to dry skin",
    cta: "Order yours today",
    presenter: "Dermatologist",
    lengthMs: 12000,
  };

  for (const ratio of ASPECT_RATIOS) {
    const rendered = renderTimelineToVideo({
      template,
      variant,
      aspectRatio: ratio,
    });

    assert.equal(rendered.composition.aspectRatio, ratio);
    assert.equal(rendered.durationMs, 12000);
    assert.ok(rendered.bytes.byteLength > 0);
    assert.ok(rendered.composition.tracks.video.length > 0);
    assert.ok(rendered.composition.tracks.audio.length > 0);
    assert.ok(rendered.composition.tracks.overlay.length > 0);

    if (ratio === "9:16") {
      assert.equal(rendered.width, 1080);
      assert.equal(rendered.height, 1920);
    } else if (ratio === "4:5") {
      assert.equal(rendered.width, 1080);
      assert.equal(rendered.height, 1350);
    } else if (ratio === "1:1") {
      assert.equal(rendered.width, 1080);
      assert.equal(rendered.height, 1080);
    } else if (ratio === "16:9") {
      assert.equal(rendered.width, 1920);
      assert.equal(rendered.height, 1080);
    }
  }
});

function patternFrame(isTop: boolean): Uint8Array {
  const png = new PNG({ width: 16, height: 16 });
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const idx = (16 * y + x) * 4;
      const active = isTop ? y < 8 : x < 8;
      const val = active ? 255 : 0;
      png.data[idx] = val;
      png.data[idx + 1] = val;
      png.data[idx + 2] = val;
      png.data[idx + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

test("Gates Step 5: originality gate compares perceptual hashes and embeddings, blocks close copies, and routes missing to review", () => {
  const frame1 = patternFrame(true);
  const identicalFrame = patternFrame(true);
  const differentFrame = patternFrame(false);

  // 1. Identical frames (distance 0 < 8) -> block
  const hashBlocked = compareOriginalityAgainstSource({
    variantFrames: [identicalFrame],
    sourceFrames: [frame1],
  });
  assert.equal(hashBlocked.result, "block");
  assert.match(hashBlocked.reason, /Frame similarity/);

  // 2. Different frames -> pass
  const hashPassed = compareOriginalityAgainstSource({
    variantFrames: [differentFrame],
    sourceFrames: [frame1],
    variantEmbedding: [1, 0, 0],
    sourceEmbedding: [0, 1, 0], // distance = 1.0 > 0.08
    variantText: "Unique new product for morning routine",
    sourceText: "Nighttime serum for anti-aging",
  });
  assert.equal(hashPassed.result, "pass");

  // 3. Close embedding distance (< 0.08) -> block
  const embBlocked = compareOriginalityAgainstSource({
    variantEmbedding: [0.999, 0.01],
    sourceEmbedding: [1.0, 0.0],
  });
  assert.equal(embBlocked.result, "block");
  assert.match(embBlocked.reason, /Embedding distance/);

  // 4. Missing comparison evidence -> review (never guessed)
  const missingResult = compareOriginalityAgainstSource({});
  assert.equal(missingResult.result, "review");
  assert.match(missingResult.reason, /No similarity evidence is stored/);
});
