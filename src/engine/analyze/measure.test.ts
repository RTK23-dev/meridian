import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loudnessValues, meanOver, segmentMeasures, tenthLoudness } from "./measure.ts";

describe("measures over a span", () => {
  const samples = [
    { atMs: 0, value: 0.2 },
    { atMs: 500, value: 0.4 },
    { atMs: 1000, value: 0.6 },
  ];

  it("averages the samples inside the span, start included and end excluded", () => {
    assert.ok(Math.abs((meanOver(samples, 0, 1000) ?? NaN) - 0.3) < 1e-9);
  });

  it("takes the nearest sample when the span holds none, and null when there are no samples", () => {
    assert.equal(meanOver(samples, 1200, 1300), 0.6);
    assert.equal(meanOver([], 0, 1000), null);
  });

  it("reads a silent loudness step as the BS.1770 gate, not as a missing value", () => {
    const values = loudnessValues([
      { atMs: 0, lufs: null },
      { atMs: 100, lufs: -20 },
    ]);
    assert.deepEqual(values, [
      { atMs: 0, value: -70 },
      { atMs: 100, value: -20 },
    ]);
  });

  it("returns the three segment measures, or null when a series is empty", () => {
    const series = {
      brightness: [{ atMs: 0, value: 0.5 }],
      motion: [{ atMs: 0, value: 0.1 }],
      loudness: [{ atMs: 0, lufs: -16 }],
    };
    assert.deepEqual(segmentMeasures({ startMs: 0, endMs: 1000 }, series), {
      motion: 0.1,
      brightness: 0.5,
      loudnessLufs: -16,
    });
    assert.equal(segmentMeasures({ startMs: 0, endMs: 1000 }, { ...series, motion: [] }), null);
  });

  it("gives the loudness of each tenth of the video, or null without a loudness series", () => {
    const loudness = Array.from({ length: 60 }, (_, index) => ({
      atMs: index * 100,
      lufs: index < 30 ? -20 : -30,
    }));
    const curve = tenthLoudness(6000, loudness);
    assert.equal(curve?.length, 10);
    assert.equal(curve?.[0], -20);
    assert.equal(curve?.[9], -30);
    assert.equal(tenthLoudness(6000, []), null);
  });
});
