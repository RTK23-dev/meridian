import assert from "node:assert/strict";
import { test } from "node:test";
import { latitudeForGroup } from "../docs/design/prototype/background.mjs";
import { ROUTE } from "../docs/design/prototype/meridian-map/map-model.mjs";

const stop = (id) => ROUTE.find((s) => s.id === id).lat;

test("each group of the walkthrough sits at the site stop of the same name", () => {
  assert.equal(latitudeForGroup("Start", 0), stop("cover"));
  assert.equal(latitudeForGroup("Create", 0), stop("create"));
  assert.equal(latitudeForGroup("Library", 0), stop("library"));
  assert.equal(latitudeForGroup("Insights", 0), stop("insights"));
  assert.equal(latitudeForGroup("Settings", 0), stop("settings"));
});

test("Home sits with Start, so moving from the cover into the workspace does not move the map", () => {
  assert.equal(latitudeForGroup("Home", 0), latitudeForGroup("Start", 0));
});

test("States and Overlay keep the place the walkthrough was last at", () => {
  assert.equal(latitudeForGroup("States", 12.5), 12.5);
  assert.equal(latitudeForGroup("Overlay", -41), -41);
});

test("an unknown group keeps the place too, rather than moving the map to nowhere", () => {
  assert.equal(latitudeForGroup("Unknown", 23), 23);
  assert.equal(latitudeForGroup(undefined, 47), 47);
});
