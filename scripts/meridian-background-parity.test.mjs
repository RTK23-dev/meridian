import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The site background exists twice: the prototype in docs/design/prototype/meridian-map (the design, and its single-file builds) and the
// app in src/components/background. The app cannot import the prototype, so this test reads both as text and checks the values that must
// agree: the distance field, the halftone's defaults, the glide and the stop latitudes.
const proto = (name) => readFileSync(new URL(`../docs/design/prototype/meridian-map/${name}`, import.meta.url), "utf8");
const app = (name) => readFileSync(new URL(`../src/components/background/${name}`, import.meta.url), "utf8");

test("the app's distance field is the prototype's, byte for byte", () => {
  const protoBits = proto("world-field.mjs").match(/bits: "([A-Za-z0-9+/=]+)"/)?.[1];
  const appBits = app("world-field.ts").match(/WORLD_FIELD_BITS = "([A-Za-z0-9+/=]+)"/)?.[1];
  assert.ok(protoBits && appBits, "both files carry the field");
  assert.equal(appBits, protoBits);
});

test("the halftone's defaults are the owner's settings in both copies", () => {
  const defaults = (text) => text.match(/HALFTONE_DEFAULTS = Object\.freeze\(\{([^}]*)\}\)/)?.[1].replace(/\s+/g, " ").trim();
  assert.ok(defaults(proto("halftone.mjs")), "the prototype declares its defaults");
  assert.equal(defaults(app("halftone.ts")), defaults(proto("halftone.mjs")));
});

test("the glide and the stop latitudes are the prototype's", () => {
  const glide = (text) => text.match(/export const GLIDE = ([0-9.]+);/)?.[1];
  assert.equal(glide(app("map-model.ts")), glide(proto("map-model.mjs")));
  const protoLats = [...proto("map-model.mjs").matchAll(/lat: (-?[0-9]+),/g)].map((m) => Number(m[1]));
  const appLats = [...app("map-model.ts").matchAll(/(cover|create|library|insights|settings): (-?[0-9]+),/g)].map((m) => Number(m[2]));
  assert.deepEqual(appLats, protoLats);
});
