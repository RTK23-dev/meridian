// Which take a shot shows (takeOfShot): pure, on states built by hand. The integration of the link and the quote is in ops/shot-preview.test.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { takeOfShot } from "./index.ts";
import type { OrchestratorState, ShotState, TakeState } from "../jobs/orchestrator.ts";

function shotOf(overrides: Partial<ShotState> = {}): ShotState {
  return { shotId: "shot_a", epoch: 0, acceptedTakeId: null, ...overrides } as ShotState;
}

function takeOf(takeId: string, overrides: Partial<TakeState> = {}): TakeState {
  return { takeId, shotId: "shot_a", round: 1, epoch: 0, stale: false, checkQueued: false, verdict: null, ...overrides } as TakeState;
}

function stateWith(shots: Record<string, ShotState>, takes: Record<string, TakeState>): OrchestratorState {
  return { shots, takes } as unknown as OrchestratorState;
}

describe("the take a shot shows", () => {
  test("an accepted take is the one shown, whatever newer takes exist", () => {
    const state = stateWith({ shot_a: shotOf({ acceptedTakeId: "take_1" }) }, { take_1: takeOf("take_1"), take_2: takeOf("take_2") });
    assert.equal(takeOfShot(state, "shot_a"), "take_1");
  });

  test("a shot not yet accepted shows its newest take of the current epoch", () => {
    const state = stateWith({ shot_a: shotOf() }, { take_1: takeOf("take_1"), take_2: takeOf("take_2") });
    assert.equal(takeOfShot(state, "shot_a"), "take_2");
  });

  test("a stale take or a take of an earlier epoch is never shown", () => {
    const state = stateWith(
      { shot_a: shotOf({ epoch: 1 }) },
      { take_old: takeOf("take_old", { epoch: 0 }), take_stale: takeOf("take_stale", { epoch: 1, stale: true }) },
    );
    assert.equal(takeOfShot(state, "shot_a"), null);
  });

  test("a shot with no takes, or no such shot, shows nothing", () => {
    const state = stateWith({ shot_a: shotOf() }, {});
    assert.equal(takeOfShot(state, "shot_a"), null);
    assert.equal(takeOfShot(state, "shot_missing"), null);
  });
});
