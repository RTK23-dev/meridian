import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../../config/thresholds.ts";
import type { ProductionRequest, ScenePlan, ShotSpec } from "../../contracts/index.ts";
import { hookTimingOf, planTimingNotesOf } from "./hookTiming.ts";

// Plain fixtures. Only the fields the hook checks read are filled in, so each object is cast to the contract type.
function shot(shotId: string, beatId: string, startMs: number, endMs: number): ShotSpec {
  return { shotId, beatId, startMs, endMs } as unknown as ShotSpec;
}

function plan(shots: ShotSpec[]): ScenePlan {
  return { shots } as unknown as ScenePlan;
}

function request(beats: Array<{ beatId: string; role: string }> | undefined): ProductionRequest {
  return (beats === undefined ? {} : { script: { language: "en", beats } }) as unknown as ProductionRequest;
}

const SCRIPT = [
  { beatId: "b1", role: "hook" },
  { beatId: "b2", role: "payoff" },
];

function rule(result: ReturnType<typeof hookTimingOf>, name: string) {
  const found = result.checks.find((item) => item.rule === name);
  assert.ok(found, `the check ${name} is reported`);
  return found;
}

describe("the hook checks at plan time", () => {
  it("the window and the latest hook are the sourced values", () => {
    assert.equal(thresholds.hook.windowMs.value, 3000);
    assert.equal(thresholds.hook.latestMs.value, 6000);
  });

  it("a hook that starts at zero passes both checks", () => {
    const result = hookTimingOf(plan([shot("s1", "b1", 0, 2000), shot("s2", "b2", 2000, 5000)]), request(SCRIPT));
    assert.equal(rule(result, "hook_within_window").pass, true);
    assert.equal(rule(result, "hook_by_latest").pass, true);
    assert.deepEqual(result.failingShotIds, []);
  });

  it("a hook at 3.5 s fails the window, passes the latest hook, and names only the hook's shot", () => {
    const result = hookTimingOf(plan([shot("s1", "b2", 0, 3500), shot("s2", "b1", 3500, 6000)]), request(SCRIPT));
    assert.equal(rule(result, "hook_within_window").pass, false);
    assert.equal(rule(result, "hook_by_latest").pass, true);
    assert.deepEqual(result.failingShotIds, ["s2"]);
  });

  it("a hook at 7 s fails both checks", () => {
    const result = hookTimingOf(plan([shot("s1", "b2", 0, 7000), shot("s2", "b1", 7000, 9000)]), request(SCRIPT));
    assert.equal(rule(result, "hook_within_window").pass, false);
    assert.equal(rule(result, "hook_by_latest").pass, false);
    assert.deepEqual(result.failingShotIds, ["s2"]);
  });

  it("a script with no hook beat fails both checks, and says why", () => {
    const result = hookTimingOf(plan([shot("s1", "b1", 0, 2000)]), request([{ beatId: "b1", role: "setup" }]));
    assert.equal(rule(result, "hook_within_window").pass, false);
    assert.match(String(rule(result, "hook_within_window").detail), /no hook beat/);
    assert.deepEqual(result.failingShotIds, []);
  });

  it("a hook beat that no shot covers fails both checks", () => {
    const result = hookTimingOf(plan([shot("s1", "b2", 0, 2000)]), request(SCRIPT));
    assert.equal(rule(result, "hook_by_latest").pass, false);
    assert.match(String(rule(result, "hook_by_latest").detail), /no shot covers the hook beat/);
  });

  it("a request with no script is not evaluated, and that fails the gate rather than passing it", () => {
    const result = hookTimingOf(plan([shot("s1", "b1", 0, 2000)]), request(undefined));
    assert.equal(rule(result, "hook_within_window").pass, false);
    assert.match(String(rule(result, "hook_within_window").detail), /not evaluated/);
  });
});

describe("the longest-shot note", () => {
  it("notes a shot longer than the hypothesised maximum, and nothing shorter", () => {
    const notes = planTimingNotesOf(plan([shot("s1", "b1", 0, 6000), shot("s2", "b2", 6000, 15000)]));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /shot s2 runs 9000 ms/);
    assert.match(notes[0]!, /a hypothesis, not a gate check/);
  });
});
