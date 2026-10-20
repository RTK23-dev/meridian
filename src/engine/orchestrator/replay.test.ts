import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeEvent } from "./contracts.ts";
import { replayAt } from "./replay.ts";

const event = (nodeId: string, state: NodeEvent["state"], costUsd: number | null = null): NodeEvent => ({
  nodeId,
  state,
  outputHash: state === "done" ? `sha256:${nodeId}` : null,
  costUsd,
  reason: null,
});

const run: NodeEvent[] = [
  event("a", "planned"),
  event("b", "planned"),
  event("a", "running"),
  event("a", "done", 0.02),
  event("b", "not_connected"),
];

test("before any event, nothing is on the canvas", () => {
  assert.equal(replayAt(run, 0).size, 0);
});

test("a step appears at its first event and shows its latest state", () => {
  const after2 = replayAt(run, 2);
  assert.equal(after2.get("a")?.state, "planned");
  assert.equal(after2.get("b")?.state, "planned");
  const after4 = replayAt(run, 4);
  assert.equal(after4.get("a")?.state, "done");
  assert.equal(after4.get("a")?.costUsd, 0.02);
  assert.equal(after4.get("b")?.state, "planned");
});

test("the whole run replays to its last state, and a count past the end is the same as the end", () => {
  const full = replayAt(run, run.length);
  assert.equal(full.get("b")?.state, "not_connected");
  assert.deepEqual([...replayAt(run, 999).entries()], [...full.entries()]);
});

test("a negative count shows nothing rather than failing", () => {
  assert.equal(replayAt(run, -3).size, 0);
});
