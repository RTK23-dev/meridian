// Places the steps of a plan on a canvas, left to right: a step sits one column to the right of the steps it reads, and steps that
// share a column stack in plan order. Pure, so the same plan always draws the same way.

import type { NodeKind, OrchestratorPlan } from "./contracts.ts";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 96;
export const COLUMN_GAP = 84;
export const ROW_GAP = 32;
export const CANVAS_PAD = 40;

export type PlacedNode = { id: string; kind: NodeKind; title: string; x: number; y: number; column: number };
export type PlacedEdge = { from: string; to: string; d: string };
export type Layout = { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number };

/** Lay out a plan whose `order` is already known (a validated plan's topological order). */
export function layoutPlan(plan: OrchestratorPlan, order: string[]): Layout {
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const column = new Map<string, number>();
  for (const id of order) {
    const node = byId.get(id);
    if (!node) throw new Error(`no step ${id} in this plan`);
    const reads = node.dependsOn.map((dep) => column.get(dep) ?? 0);
    column.set(id, reads.length === 0 ? 0 : Math.max(...reads) + 1);
  }

  const rowInColumn = new Map<number, number>();
  const placed = new Map<string, PlacedNode>();
  for (const node of plan.nodes) {
    const col = column.get(node.id);
    if (col === undefined) throw new Error(`step ${node.id} is not in the order`);
    const row = rowInColumn.get(col) ?? 0;
    rowInColumn.set(col, row + 1);
    placed.set(node.id, {
      id: node.id,
      kind: node.kind,
      title: node.title,
      x: CANVAS_PAD + col * (NODE_WIDTH + COLUMN_GAP),
      y: CANVAS_PAD + row * (NODE_HEIGHT + ROW_GAP),
      column: col,
    });
  }

  const edges: PlacedEdge[] = [];
  for (const node of plan.nodes) {
    const to = placed.get(node.id);
    if (!to) continue;
    for (const dep of node.dependsOn) {
      const from = placed.get(dep);
      if (!from) continue;
      const x1 = from.x + NODE_WIDTH;
      const y1 = from.y + NODE_HEIGHT / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_HEIGHT / 2;
      const bend = COLUMN_GAP / 2;
      edges.push({ from: dep, to: node.id, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` });
    }
  }

  const columns = Math.max(0, ...column.values()) + 1;
  const tallest = Math.max(1, ...rowInColumn.values());
  return {
    nodes: [...placed.values()],
    edges,
    width: CANVAS_PAD * 2 + columns * NODE_WIDTH + (columns - 1) * COLUMN_GAP,
    height: CANVAS_PAD * 2 + tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP,
  };
}
