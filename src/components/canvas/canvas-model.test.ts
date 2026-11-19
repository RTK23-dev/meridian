import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_H,
  BOARD_W,
  boardWires,
  CARD_H,
  CARD_W,
  canvasFigures,
  canvasNodes,
  canvasRefetchMs,
  dotText,
  excerpt,
  fileCounts,
  fitZoom,
  nextMove,
  nodeStateOf,
  SLOT_ORDER,
  slotPosition,
  spendLine,
  stepZoom,
} from "./canvas-model.ts";
import type { Checkpoints, ProjectState } from "../../lib/meridian/mcp/workflow.ts";

const resolved = (decidedBy: "person" | "chat" | "decision_engine", content: string | null, extra: Partial<{ input: string; choice: string }> = {}) => ({
  status: "resolved" as const, options: [], proposedAt: null, choice: extra.choice ?? null, input: extra.input ?? null, decidedBy, content, resolvedAt: "2026-11-18T10:00:00.000Z",
});
const proposed = { status: "proposed" as const, options: [{ label: "A", summary: "a" }, { label: "B", summary: "b" }], proposedAt: "2026-11-18T10:00:00.000Z", choice: null, input: null, decidedBy: null, content: null, resolvedAt: null };

function project(mode: ProjectState["mode"], checkpoints: Checkpoints, status: ProjectState["status"] = "active") {
  return { mode, status, checkpoints, budgetUsd: 5, spentUsd: 0.42 };
}

test("each step's state follows the checkpoints, the mode and who decides", () => {
  const studio = project("studio", { concept: resolved("person", "A cat explains tides."), script: proposed });
  assert.equal(nodeStateOf(studio, "concept"), "settled");
  assert.equal(nodeStateOf(studio, "script"), "yours");
  assert.equal(nodeStateOf(studio, "storyboard"), "later");
  assert.equal(nodeStateOf(project("studio", { concept: resolved("person", "x") }), "script"), "options", "the chat has not offered options yet");
  assert.equal(nodeStateOf(project("orchestrator", { concept: resolved("chat", "x") }), "script"), "working");
  assert.equal(nodeStateOf(project("orchestrator", { concept: resolved("chat", "x") }, "abandoned"), "script"), "stopped");
});

test("a node carries what was settled, never more than a line, and nothing when nothing is stored", () => {
  const nodes = canvasNodes(project("guided", { concept: resolved("decision_engine", null, { input: "  Tides,\n explained   by a cat " }) }));
  assert.equal(nodes.length, 7);
  assert.equal(nodes[0]!.excerpt, "Tides, explained by a cat");
  assert.equal(nodes[0]!.decidedBy, "decision_engine");
  assert.equal(nodes[1]!.decides, "person", "guided: the person settles the script");
  assert.equal(nodes[1]!.excerpt, null);
  assert.equal(excerpt("word ".repeat(60), 40)!.endsWith("…"), true);
  assert.ok(excerpt("word ".repeat(60), 40)!.length <= 40);
  assert.equal(excerpt("   "), null);
});

test("the board is a three by three snake, and every card sits inside it without overlap", () => {
  const cells = SLOT_ORDER.map((slot) => slotPosition(slot));
  for (const cell of cells) {
    assert.ok(cell.x >= 0 && cell.x + CARD_W <= BOARD_W && cell.y >= 0 && cell.y + CARD_H <= BOARD_H);
  }
  const keys = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
  assert.equal(keys.size, SLOT_ORDER.length);
  assert.deepEqual([slotPosition("script").y, slotPosition("storyboard").x], [slotPosition("brief").y, slotPosition("script").x], "the snake turns down at the right edge");
});

test("wires run in the snake's order, done into settled steps and live into the step being worked on", () => {
  const nodes = canvasNodes(project("orchestrator", { concept: resolved("chat", "c") }));
  const wires = boardWires(nodes);
  assert.equal(wires.length, SLOT_ORDER.length - 1);
  assert.deepEqual(wires.slice(0, 3).map((wire) => [wire.to, wire.state]), [["concept", "done"], ["script", "live"], ["storyboard", "idle"]]);
  const turn = wires.find((wire) => wire.to === "storyboard")!;
  assert.match(turn.d, /^M .* C /, "a wire between rows is a curve");
  assert.equal(boardWires(null).every((wire) => wire.state === "idle"), true);
});

test("the figures count settled steps, choices waiting and who decided", () => {
  const figures = canvasFigures(canvasNodes(project("studio", { concept: resolved("person", "c"), script: proposed })));
  assert.equal(figures.settled, 1);
  assert.equal(figures.percent, 14);
  assert.equal(figures.waitingOnYou, 1);
  assert.deepEqual(figures.decidedBy, { person: 1, chat: 0, decision_engine: 0 });
  assert.deepEqual(figures.bars.slice(0, 3), [1, 0.55, 0.18]);
  assert.equal(figures.current?.phase, "script");
  assert.deepEqual(nextMove({ status: "active" }, figures), { label: "Choose the script", short: "Choose", kind: "choose" });
  assert.deepEqual(nextMove({ status: "delivered" }, figures).kind, "watch");
  assert.deepEqual(nextMove({ status: "abandoned" }, figures).kind, "new");
});

test("a project being made is followed closely, one waiting on the person now and then, and a finished one not at all", () => {
  assert.equal(canvasRefetchMs(project("orchestrator", {})), 4_000);
  assert.equal(canvasRefetchMs(project("studio", { concept: proposed })), 15_000);
  assert.equal(canvasRefetchMs(project("studio", {}, "delivered")), false);
  assert.equal(canvasRefetchMs(null), false);
});

test("spend, files and zoom are plain figures", () => {
  assert.equal(spendLine({ budgetUsd: 5, spentUsd: 0.42 }), "$0.42 of $5.00");
  assert.equal(spendLine({ budgetUsd: null, spentUsd: 1 }), "$1.00, no cap of its own");
  assert.deepEqual(fileCounts([{ kind: "voiceover" }, { kind: "video" }, { kind: "image" }, { kind: "image" }]), { voiceover: 1, image: 2, video: 1 });
  assert.equal(fitZoom(BOARD_W * 2), 1);
  assert.equal(fitZoom(BOARD_W * 0.8), 0.8);
  assert.equal(fitZoom(100), 0.5);
  assert.equal(stepZoom(0.75, 1), 0.85);
  assert.equal(stepZoom(0.75, -1), 0.6);
  assert.equal(stepZoom(1, 1), 1);
});

test("the dot face spells the wordmark with a blank column between letters", () => {
  const word = dotText("Meridian");
  assert.equal(word.height, 7);
  assert.equal(word.width, 8 * 5 + 7);
  assert.ok(word.dots.length > 100);
  assert.deepEqual(dotText("I").dots.slice(0, 3), [[1, 0], [2, 0], [3, 0]]);
  assert.equal(dotText("?").width, 0, "letters the face lacks are left out");
});
