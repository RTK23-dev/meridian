// The phase dots read the stored session: Direction waits for evidence, each later phase opens once the one before it has data, Queue is
// current once a variant is approved and done once one is published.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isStudioPhase, STUDIO_PHASES, studioPhases } from "./studio-phases.ts";
import type { StudioData } from "./types.ts";

const empty = { recommendation: null, variants: [], publications: [] } as unknown as StudioData;

test("an empty Studio waits on Direction, and every later phase is ahead", () => {
  const phases = studioPhases(empty, null);
  assert.deepEqual(phases.map((phase) => phase.key), STUDIO_PHASES.map((phase) => phase.key));
  assert.deepEqual(phases.map((phase) => phase.state), ["current", "upcoming", "upcoming", "upcoming", "upcoming"]);
});

test("an approved variant makes Queue current, and a publication makes it done", () => {
  const variant = { creativeStatus: "approved", reviewStatus: "closed" };
  const withApproved = { recommendation: { id: "r" }, variants: [variant], publications: [] } as unknown as StudioData;
  const brief = { status: "ready" } as unknown as Parameters<typeof studioPhases>[1];
  const phases = studioPhases(withApproved, brief);
  assert.equal(phases.at(-1)!.state, "current");
  const published = studioPhases({ ...withApproved, publications: [{}] } as unknown as StudioData, brief);
  assert.equal(published.at(-1)!.state, "done");
});

test("only the five phase names are phases", () => {
  assert.ok(isStudioPhase("review"));
  assert.ok(!isStudioPhase("publish"));
});
