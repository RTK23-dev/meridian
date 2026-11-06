// Directed, not described: a plan whose picture steps have no Director upstream, no fact-check between, or no shot named is accepted
// with a note; a directed plan carries none.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrchestratorPlan, PlanNode } from "./contracts.ts";
import { directionNotes } from "./direction.ts";

const step = (id: string, kind: PlanNode["kind"], dependsOn: string[] = [], params: PlanNode["params"] = {}): PlanNode => ({
  id,
  kind,
  title: id,
  why: "a step",
  dependsOn,
  model: kind === "edit" || kind === "compose" || kind === "render" ? null : { provider: "openrouter", id: "vendor/model" },
  params,
  estimateUsd: null,
});
const plan = (nodes: PlanNode[]): OrchestratorPlan => ({
  version: "orchestrator-plan@1",
  orchestrator: { provider: "openrouter", id: "vendor/model" },
  budgetUsd: 5,
  nodes,
});

describe("direction notes", () => {
  it("say nothing for a plan that makes no picture", () => {
    assert.deepEqual(directionNotes(plan([step("script", "script"), step("voice", "voice", ["script"]), step("render", "render", ["voice"])])), []);
  });

  it("say once that the pictures are described when there is no Director", () => {
    const notes = directionNotes(plan([step("script", "script"), step("shot_1", "video", ["script"], { prompt: "a flame" })]));
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /described, not directed/);
  });

  it("say nothing for a directed plan: Director, fact-check, one picture per named shot", () => {
    const notes = directionNotes(
      plan([
        step("script", "script"),
        step("director", "script", ["script"], { role: "director", prompt: "shot_director@1" }),
        step("fact_check", "analysis", ["director"], { role: "fact_checker" }),
        step("shot_1", "video", ["fact_check"], { shot: "s1", prompt: "the zap" }),
        step("take_review", "edit", ["shot_1"], { checks: "direction,faith,take" }),
        step("render", "render", ["take_review"]),
      ]),
    );
    assert.deepEqual(notes, []);
  });

  it("name the picture step that skips the fact-check, names no shot, or has no Director upstream", () => {
    const notes = directionNotes(
      plan([
        step("director", "script", [], { role: "director" }),
        step("fact_check", "analysis", ["director"], { role: "fact_checker" }),
        step("shot_1", "video", ["director"], { shot: "s1" }),
        step("shot_2", "video", ["fact_check"]),
        step("still", "visual", []),
      ]),
    );
    assert.deepEqual(notes, [
      "step shot_1: no fact-check step stands between the Director and this picture (L23)",
      "step shot_2: does not name the shot of the direction it builds (params.shot) (L1)",
      "step still: makes a picture with no Director step upstream, so it is described, not directed (L2)",
    ]);
  });
});
