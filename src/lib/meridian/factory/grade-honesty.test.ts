import test from "node:test";
import assert from "node:assert/strict";
import { sourceMetricsOf } from "../research/store.ts";
import { buildAdTimeline } from "./timeline.ts";
import { winnerScore, type WinnerEvidence } from "./winner-score.ts";

const complete: WinnerEvidence = {
  daysRunning: 40,
  stillRunning: true,
  iterationCount: 2,
  countries: 3,
  platforms: 2,
  advertiserSurvivorRate: 0.5,
  creativeQuality: 0.5,
};

test("an unknown delivery status is not counted as running, and one sighting measures no run", () => {
  const timeline = buildAdTimeline({
    sightings: [
      { seenAt: "2026-09-01T00:00:00.000Z", platforms: ["facebook"], countries: ["US"], reachLow: null, reachHigh: null, stillRunning: null },
    ],
  });
  assert.ok(timeline);
  assert.equal(timeline.stillRunning, null);
  assert.equal(timeline.daysRunning, 0, "a single sighting gives no measured run length");

  const scored = winnerScore({ ...complete, daysRunning: 0, stillRunning: null, advertiserSurvivorRate: null, creativeQuality: null });
  assert.equal(scored.components.survival, 0, "unknown delivery earns no survival credit");
  assert.equal(scored.components.advertiser, 0, "an unknown track record is zero, not an assumed 0.4");
  assert.equal(scored.components.quality, 0, "an unknown quality is zero, not an assumed value");
  assert.ok(scored.evidence.some((line) => /not reported/.test(line)));
});

test("an ad that stopped scores lower on survival than one still delivering, over the same run", () => {
  const live = winnerScore({ ...complete, stillRunning: true });
  const stopped = winnerScore({ ...complete, stillRunning: false });
  assert.ok(live.components.survival > stopped.components.survival);
  assert.ok(stopped.evidence.some((line) => /stopped/.test(line)));
});

test("missing evidence widens the range, and complete evidence gives the narrowest one", () => {
  const full = winnerScore(complete);
  const missing = winnerScore({ ...complete, stillRunning: null, advertiserSurvivorRate: null, creativeQuality: null });
  assert.ok(missing.high - missing.low > full.high - full.low);
});

test("the stored source metrics keep the stop time and the countries, so a later grade can read delivery", () => {
  const stored = JSON.parse(sourceMetricsOf({ stoppedAt: null, countries: ["US", "CA"], capturedAt: "2026-10-01T00:00:00.000Z" })) as Record<string, unknown>;
  assert.ok("stoppedAt" in stored, "the key is present, so a null means still delivering, not unknown");
  assert.equal(stored.stoppedAt, null);
  assert.deepEqual(stored.countries, ["US", "CA"]);

  const stopped = JSON.parse(sourceMetricsOf({ stoppedAt: "2026-09-20T00:00:00.000Z", countries: [], capturedAt: "2026-10-01T00:00:00.000Z" })) as Record<string, unknown>;
  assert.equal(stopped.stoppedAt, "2026-09-20T00:00:00.000Z");
});
