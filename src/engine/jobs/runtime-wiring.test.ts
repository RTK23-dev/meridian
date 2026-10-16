import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReferencePorts } from "../analyze/reference.ts";
import type { RoleDeps } from "../claude/client.ts";
import type { PictureClient } from "../media/index.ts";
import { analysisPortsOf } from "./runtime.ts";

const ROLES = {} as unknown as RoleDeps;
const PICTURE = (async () => ({ pairs: [], loopDistance: null })) as unknown as PictureClient;

test("analyze_reference keeps its ports as given when no picture client is connected (readings stay unknown)", () => {
  const analysis = { roles: ROLES } as unknown as ReferencePorts;
  assert.equal(analysisPortsOf(analysis, undefined), analysis);
});

test("with a picture client and no readings of its own, analyze_reference reads through analysisReadings", () => {
  const analysis = { roles: ROLES } as unknown as ReferencePorts;
  const wired = analysisPortsOf(analysis, PICTURE);
  assert.equal(typeof wired.readings, "function", "the readings port is wired");
  assert.equal(wired.roles, ROLES, "the stage keeps its own role deps");
  assert.notEqual(wired, analysis, "the wired ports are a new object; the composition's ports are not changed");
});

test("readings a composition gives itself are not replaced by the picture wiring", () => {
  const own = async () => ({ captions: null, zoom: null, loop: null });
  const analysis = { roles: ROLES, readings: own } as unknown as ReferencePorts;
  assert.equal(analysisPortsOf(analysis, PICTURE), analysis);
});
