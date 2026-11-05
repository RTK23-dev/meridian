import assert from "node:assert/strict";
import test from "node:test";
import type { ScriptCard } from "../../lib/meridian/direction/scripts-view.ts";
import { costWords, lineagesOf, scriptState, seatWords, seconds, writeBlock, writeLabel } from "./create-scripts-model.ts";

function card(id: string, input: Partial<ScriptCard> & { runId: string; createdAt: string }): ScriptCard {
  return {
    id,
    parentId: null,
    version: 1,
    rank: null,
    state: "option",
    ships: true,
    blocked: false,
    concept: { hookFamily: "", format: "", feeling: "", angle: "", promise: "", payoff: "", novelty: "" },
    topic: null,
    language: "en",
    durationMs: 1000,
    beats: [],
    rationale: "",
    findings: [],
    counts: { block: 0, warn: 0, info: 0 },
    floors: { trust: "pass", originality: "pass" },
    swipe: null,
    drafts: 1,
    ...input,
  };
}

test("versions group under their first script; the newest run comes first, its best option first", () => {
  const scripts = [
    card("a2", { runId: "r3", createdAt: "2026-11-05T10:05:00Z", parentId: "a1", version: 2, rank: 2 }),
    card("a1", { runId: "r1", createdAt: "2026-11-05T10:00:00Z", rank: 2 }),
    card("b1", { runId: "r1", createdAt: "2026-11-05T10:00:00Z", rank: 1 }),
    card("c1", { runId: "r2", createdAt: "2026-11-05T10:03:00Z", rank: 1 }),
    card("a3", { runId: "r4", createdAt: "2026-11-05T10:07:00Z", parentId: "a2", version: 3, rank: 2 }),
  ];
  const lineages = lineagesOf(scripts);
  assert.deepEqual(
    lineages.map((lineage) => [lineage.rootId, lineage.versions.map((version) => version.id)]),
    [
      ["c1", ["c1"]],
      ["b1", ["b1"]],
      ["a1", ["a1", "a2", "a3"]],
    ],
  );
});

test("times, costs and states are said plainly; an unknown cost is never $0", () => {
  assert.equal(seconds(2100), "2.1s");
  assert.equal(seconds(0), "0.0s");
  assert.equal(costWords({ status: "ready", costUsd: 0.4231, calls: 30 }), "$0.42, as the provider reported it.");
  assert.match(costWords({ status: "needs_person", costUsd: null, calls: 30 }), /^The cost is unknown/);
  assert.equal(costWords({ status: "queued", costUsd: null, calls: 0 }), "Nothing spent yet.");
  assert.deepEqual(scriptState({ blocked: true, ships: false, state: "option" }), { label: "Blocked: revise it", variant: "danger" });
  assert.equal(scriptState({ blocked: false, ships: true, state: "chosen" }).label, "In the draft");
  assert.equal(writeLabel(1), "Write a script");
  assert.equal(writeLabel(3), "Write 3 scripts to choose from");
});

test("the write button says why it cannot be pressed", () => {
  const seats = { ok: true as const, seats: { slots: {}, writers: ["a/x"], judge: "a/x", director: "a/x", view: { writer: "a/x", secondWriter: null, judge: "a/x", secondWriterAuto: true, judgeAuto: true } } };
  const base = { canAdmin: true, draft: true, working: false, seats, maxSeconds: 30, language: "en" };
  assert.equal(writeBlock(base), null);
  assert.match(writeBlock({ ...base, canAdmin: false }) ?? "", /Only a workspace admin/);
  assert.match(writeBlock({ ...base, working: true }) ?? "", /already|working/);
  assert.equal(writeBlock({ ...base, seats: { ok: false, reason: "No model is chosen for Copy and scripts." } }), "No model is chosen for Copy and scripts.");
  assert.match(writeBlock({ ...base, maxSeconds: 400 }) ?? "", /5 to 180/);
  assert.match(writeBlock({ ...base, language: "English" }) ?? "", /tag/);
  assert.match(seatWords(seats), /^Writers: a\/x \(one family.*Judge: a\/x \(Auto: the same model judges its own ideas/);
  assert.equal(seatWords(null), "Checking the models...");
});
