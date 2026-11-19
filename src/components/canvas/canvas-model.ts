// The video canvas, as pure rules: which state each step is in, where its card sits, how the wires run between cards, what the widgets
// count, how often a project is re-read, and the dot-matrix letters of the wordmark. No React here, so every rule is tested directly.
// A project is the connector's video project (src/lib/meridian/mcp/workflow.ts): seven steps, each settled by the person or the chat
// according to the mode. Nothing is invented: a step with nothing stored shows that nothing is stored.

import { currentPhase, decidesFor, DECIDERS, MODE_COPY, PHASE_COPY, PHASES, type Checkpoint, type Decider, type Phase, type ProjectMode, type ProjectState } from "../../lib/meridian/mcp/workflow.ts";

export type CanvasProjectLike = Pick<ProjectState, "mode" | "status" | "checkpoints"> & { budgetUsd: number | null; spentUsd: number };

/**
 * A step's state on the canvas.
 * settled: the checkpoint is resolved. yours: the person decides and the options are waiting for them. options: the person decides, and the
 * chat has not offered options yet. working: the chat decides this step and is on it. later: a step after the current one. stopped: the
 * video was abandoned before this step was settled.
 */
export type NodeState = "settled" | "yours" | "options" | "working" | "later" | "stopped";

export const NODE_STATE_WORDS: Record<NodeState, string> = {
  settled: "Settled",
  yours: "Your choice",
  options: "Options coming",
  working: "Chat is on it",
  later: "Later",
  stopped: "Stopped",
};

export const DECIDER_WORDS: Record<Decider, string> = { person: "You", chat: "The chat", decision_engine: "Decision engine" };

export function deciderWords(decider: Decider): string {
  return DECIDER_WORDS[decider];
}

export type CanvasNode = {
  phase: Phase;
  index: number;
  label: string;
  settles: string;
  state: NodeState;
  /** Who settles this step in the project's mode. */
  decides: "person" | "chat";
  /** Who settled it, when it is settled. */
  decidedBy: Decider | null;
  /** What was settled, in a line: the content, the person's words or the option. Null when nothing is stored. */
  excerpt: string | null;
  optionCount: number;
  resolvedAt: string | null;
};

/** The settled text of a checkpoint: what the next step builds on. */
export function settledText(checkpoint: Checkpoint | undefined): string | null {
  if (!checkpoint || checkpoint.status !== "resolved") return null;
  return checkpoint.content ?? checkpoint.input ?? checkpoint.choice ?? null;
}

/** One line of a long text: whitespace collapsed, cut at a word before the limit, with an ellipsis when it was cut. */
export function excerpt(text: string | null | undefined, max = 140): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

export function nodeStateOf(project: Pick<ProjectState, "mode" | "status" | "checkpoints">, phase: Phase): NodeState {
  const checkpoint = project.checkpoints[phase];
  if (checkpoint?.status === "resolved") return "settled";
  if (project.status === "abandoned") return "stopped";
  const current = currentPhase(project.checkpoints);
  if (current !== phase) return "later";
  if (decidesFor(project.mode, phase) === "chat") return "working";
  return checkpoint?.status === "proposed" ? "yours" : "options";
}

export function canvasNodes(project: Pick<ProjectState, "mode" | "status" | "checkpoints">): CanvasNode[] {
  return PHASES.map((phase, index) => {
    const checkpoint = project.checkpoints[phase];
    const state = nodeStateOf(project, phase);
    return {
      phase,
      index,
      label: PHASE_COPY[phase].label,
      settles: PHASE_COPY[phase].settles,
      state,
      decides: decidesFor(project.mode, phase),
      decidedBy: checkpoint?.status === "resolved" ? checkpoint.decidedBy : null,
      excerpt: excerpt(settledText(checkpoint)),
      optionCount: checkpoint?.status === "proposed" ? checkpoint.options.length : 0,
      resolvedAt: checkpoint?.resolvedAt ?? null,
    };
  });
}

// ---- layout ---------------------------------------------------------------------------------------------------------------------

/** The cards of the board: the brief, the seven steps, and the files the video made. */
export type SlotId = "brief" | Phase | "files";
export const SLOT_ORDER: readonly SlotId[] = ["brief", ...PHASES, "files"];

export const CARD_W = 220;
export const CARD_H = 204;
const GAP_X = 52;
const GAP_Y = 64;
const PAD = 32;

/** Each card's cell on a three by three board. The order runs as a snake: right along the top, back along the middle, right along the bottom. */
const CELLS: Record<SlotId, [number, number]> = {
  brief: [0, 0],
  concept: [1, 0],
  script: [2, 0],
  storyboard: [2, 1],
  assets: [1, 1],
  build: [0, 1],
  render: [0, 2],
  deliver: [1, 2],
  files: [2, 2],
};

export const BOARD_W = PAD * 2 + CARD_W * 3 + GAP_X * 2;
export const BOARD_H = PAD * 2 + CARD_H * 3 + GAP_Y * 2;

export function slotPosition(slot: SlotId): { x: number; y: number } {
  const [col, row] = CELLS[slot];
  return { x: PAD + col * (CARD_W + GAP_X), y: PAD + row * (CARD_H + GAP_Y) };
}

export type Wire = { from: SlotId; to: SlotId; d: string; start: [number, number]; end: [number, number]; state: "done" | "live" | "idle" };

/**
 * The wires between cards, in the snake's order. A wire between cards on one row runs edge to edge at mid-height; between rows it drops
 * from the bottom of one card to the top of the next. Its state: done when its target is settled, live when its target is the step being
 * worked on now, idle otherwise.
 */
export function boardWires(nodes: CanvasNode[] | null): Wire[] {
  const stateOf = (slot: SlotId): NodeState | null => (slot === "brief" || slot === "files" ? null : nodes?.find((node) => node.phase === slot)?.state ?? null);
  const wires: Wire[] = [];
  for (let i = 0; i < SLOT_ORDER.length - 1; i++) {
    const from = SLOT_ORDER[i]!, to = SLOT_ORDER[i + 1]!;
    const a = slotPosition(from), b = slotPosition(to);
    let start: [number, number], end: [number, number], d: string;
    if (a.y === b.y) {
      const rightward = b.x > a.x;
      start = [rightward ? a.x + CARD_W : a.x, a.y + CARD_H / 2];
      end = [rightward ? b.x : b.x + CARD_W, b.y + CARD_H / 2];
      d = `M ${start[0]} ${start[1]} L ${end[0]} ${end[1]}`;
    } else {
      start = [a.x + CARD_W / 2, a.y + CARD_H];
      end = [b.x + CARD_W / 2, b.y];
      const mid = (start[1] + end[1]) / 2;
      d = `M ${start[0]} ${start[1]} C ${start[0]} ${mid}, ${end[0]} ${mid}, ${end[0]} ${end[1]}`;
    }
    const target = to === "files" ? (stateOf("deliver") === "settled" ? "settled" : null) : stateOf(to);
    const state = target === "settled" ? "done" : target === "working" || target === "yours" || target === "options" ? "live" : "idle";
    wires.push({ from, to, d, start, end, state });
  }
  return wires;
}

/** The zoom that fits the board's width into the frame, between half size and full size, in steps of 5%. */
export function fitZoom(frameWidth: number): number {
  if (!(frameWidth > 0)) return 1;
  const raw = frameWidth / BOARD_W;
  return Math.min(1, Math.max(0.5, Math.floor(raw * 20) / 20));
}

export const ZOOM_STEPS = [0.5, 0.6, 0.75, 0.85, 1] as const;

export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + 1e-6) ?? 1;
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 1e-6) ?? 0.5;
}

// ---- widgets ----------------------------------------------------------------------------------------------------------------------

export type CanvasFigures = {
  settled: number;
  total: number;
  percent: number;
  /** One bar per step, 0 to 1: settled is full, the current step is half, later steps are a stub. */
  bars: number[];
  waitingOnYou: number;
  decidedBy: Record<Decider, number>;
  current: CanvasNode | null;
};

export function canvasFigures(nodes: CanvasNode[]): CanvasFigures {
  const settled = nodes.filter((node) => node.state === "settled").length;
  const decidedBy = Object.fromEntries(DECIDERS.map((decider) => [decider, nodes.filter((node) => node.decidedBy === decider).length])) as Record<Decider, number>;
  return {
    settled,
    total: nodes.length,
    percent: nodes.length === 0 ? 0 : Math.round((settled / nodes.length) * 100),
    bars: nodes.map((node) => (node.state === "settled" ? 1 : node.state === "later" || node.state === "stopped" ? 0.18 : 0.55)),
    waitingOnYou: nodes.filter((node) => node.state === "yours").length,
    decidedBy,
    current: nodes.find((node) => node.state !== "settled" && node.state !== "later" && node.state !== "stopped") ?? null,
  };
}

export type FileKindCount = { voiceover: number; image: number; video: number };

export function fileCounts(files: ReadonlyArray<{ kind: string }>): FileKindCount {
  return {
    voiceover: files.filter((file) => file.kind === "voiceover").length,
    image: files.filter((file) => file.kind === "image").length,
    video: files.filter((file) => file.kind === "video").length,
  };
}

/** "$0.42 of $5.00", or "$0.42, no cap of its own" when the video has no budget of its own. */
export function spendLine(project: Pick<CanvasProjectLike, "budgetUsd" | "spentUsd">): string {
  const spent = `$${project.spentUsd.toFixed(2)}`;
  return project.budgetUsd === null ? `${spent}, no cap of its own` : `${spent} of $${project.budgetUsd.toFixed(2)}`;
}

export type NextMove = { label: string; short: string; kind: "choose" | "follow" | "watch" | "new" };

/** The hero card's next move for the person: the full words for a screen reader, and the short word on the button. */
export function nextMove(project: Pick<CanvasProjectLike, "status">, figures: CanvasFigures): NextMove {
  if (project.status === "abandoned") return { label: "Make a new video", short: "New video", kind: "new" };
  if (project.status === "delivered") return { label: "Watch the video", short: "Watch", kind: "watch" };
  const current = figures.current;
  if (current?.state === "yours") return { label: `Choose the ${current.label.toLowerCase()}`, short: "Choose", kind: "choose" };
  if (current) return { label: `Follow the ${current.label.toLowerCase()}`, short: "Follow", kind: "follow" };
  return { label: "Watch the video", short: "Watch", kind: "watch" };
}

/**
 * How often the open project is read again, in ms, or false for not at all. A step the chat is making is followed closely; a step
 * waiting for the person is checked now and then (another person or the chat may change it); a finished video is not polled.
 */
export function canvasRefetchMs(project: CanvasProjectLike | null): number | false {
  if (!project || project.status !== "active") return false;
  const phase = currentPhase(project.checkpoints);
  if (phase === null) return false;
  const state = nodeStateOf(project, phase);
  return state === "yours" ? 15_000 : 4_000;
}

export const MODE_LETTER: Record<ProjectMode, string> = { studio: "S", guided: "G", orchestrator: "O" };

export function modeSummary(mode: ProjectMode): { label: string; summary: string } {
  return MODE_COPY[mode];
}

// ---- the dot-matrix letters ---------------------------------------------------------------------------------------------------

/** A 5 by 7 dot face for the wordmark and the big figures. "#" is a lit dot. */
const GLYPHS: Record<string, readonly string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  "%": ["##..#", "##..#", "...#.", "..#..", ".#...", "#..##", "#..##"],
  ".": [".", ".", ".", ".", ".", "#", "#"],
  " ": ["..", "..", "..", "..", "..", "..", ".."],
};

export type DotText = { width: number; height: number; dots: Array<[number, number]> };

/** The lit dots of a text in the dot face, with one blank column between letters. Letters the face lacks are left out. */
export function dotText(text: string): DotText {
  const dots: Array<[number, number]> = [];
  let x = 0;
  const letters = [...text.toUpperCase()].filter((letter) => GLYPHS[letter]);
  letters.forEach((letter, i) => {
    const rows = GLYPHS[letter]!;
    rows.forEach((row, y) => [...row].forEach((cell, cx) => { if (cell === "#") dots.push([x + cx, y]); }));
    x += rows[0]!.length + (i < letters.length - 1 ? 1 : 0);
  });
  return { width: x, height: 7, dots };
}
