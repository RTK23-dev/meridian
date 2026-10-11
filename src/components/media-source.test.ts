import assert from "node:assert/strict";
import test from "node:test";
import { aspectRatio, assetSource, durationLabel, posterSource } from "./media-source.ts";

test("a stored asset is served from its own path, with the id encoded", () => {
  assert.equal(assetSource("asset-1"), "/api/assets/asset-1");
  assert.equal(assetSource("a/b c?x"), "/api/assets/a%2Fb%20c%3Fx", "an id cannot change the path");
});

test("a stored video shows its stored still by default, and an explicit poster replaces it", () => {
  assert.equal(posterSource({ assetId: "asset-1" }), "/api/assets/asset-1?thumb=1");
  assert.equal(posterSource({ assetId: "asset-1", poster: "/custom.png" }), "/custom.png");
  assert.equal(posterSource({ poster: "https://cdn.example.com/still.jpg" }), "https://cdn.example.com/still.jpg");
});

test("a null poster means no poster, even for a stored asset", () => {
  assert.equal(posterSource({ assetId: "asset-1", poster: null }), undefined);
  assert.equal(posterSource({ poster: null }), undefined);
});

test("a plain media URL with no poster shows none, rather than a made-up still", () => {
  assert.equal(posterSource({}), undefined);
});

test("the box uses the real dimensions, and falls back to 16:9 without both", () => {
  assert.equal(aspectRatio(1080, 1920), "1080 / 1920");
  assert.equal(aspectRatio(undefined, undefined), "16 / 9");
  assert.equal(aspectRatio(1080, null), "16 / 9");
  assert.equal(aspectRatio(0, 1080), "16 / 9");
});

test("a stored duration is shown in seconds, and a missing one is stated as not stored", () => {
  assert.equal(durationLabel(12_345), "12.3 seconds");
  assert.equal(durationLabel(null), "duration not stored");
  assert.equal(durationLabel(undefined), "duration not stored");
  assert.equal(durationLabel(0), "duration not stored", "a zero duration is not a stored duration");
  assert.equal(durationLabel(Number.NaN), "duration not stored");
});
