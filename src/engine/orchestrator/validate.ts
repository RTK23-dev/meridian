// Checks a plan before any step runs. Pure: the plan and the live catalog in, a list of reasons out. A plan that fails any check
// does not run at all (fail closed). Every reason names the step it is about, so the canvas can point at it.

import type { CatalogEntry, CatalogKind } from "./catalog.ts";
import type { NodeKind, OrchestratorPlan, PlanNode } from "./contracts.ts";

/** The catalog kind a step's model must be. A step whose kind is not listed here makes no model call and must have no model. */
export const KIND_CATALOG: Partial<Record<NodeKind, CatalogKind>> = {
  analysis: "text",
  script: "text",
  visual: "image",
  video: "video",
  avatar: "video",
  voice: "speech",
};

export type ValidationResult = { ok: true; order: string[] } | { ok: false; reasons: string[] };

/** The steps in an order where every step comes after the steps it depends on. Null when the graph has a cycle. */
export function topologicalOrder(nodes: PlanNode[]): string[] | null {
  const pending = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)]));
  const order: string[] = [];
  while (pending.size > 0) {
    // Take ready steps in the plan's own order, so the same plan always gives the same order.
    const ready = nodes.filter((node) => pending.has(node.id) && (pending.get(node.id)?.size ?? 0) === 0);
    if (ready.length === 0) return null;
    for (const node of ready) {
      order.push(node.id);
      pending.delete(node.id);
    }
    for (const deps of pending.values()) for (const id of order) deps.delete(id);
  }
  return order;
}

/** Validate a parsed plan against the live catalog. The orchestrator model must be a live text model. */
export function validatePlan(plan: OrchestratorPlan, catalog: Map<string, CatalogEntry>): ValidationResult {
  const reasons: string[] = [];

  const orchestrator = catalog.get(plan.orchestrator.id);
  if (!orchestrator) reasons.push(`orchestrator ${plan.orchestrator.id} is not in the live catalog`);
  else if (orchestrator.kind !== "text") reasons.push(`orchestrator ${plan.orchestrator.id} is a ${orchestrator.kind} model, not a text model`);

  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (ids.has(node.id)) reasons.push(`step ${node.id}: duplicate id`);
    ids.add(node.id);
  }

  let paidTotal = 0;
  for (const node of plan.nodes) {
    for (const dep of node.dependsOn) {
      if (dep === node.id) reasons.push(`step ${node.id}: depends on itself`);
      else if (!ids.has(dep)) reasons.push(`step ${node.id}: depends on unknown step ${dep}`);
    }

    const expected = KIND_CATALOG[node.kind];
    if (expected === undefined) {
      if (node.model !== null) reasons.push(`step ${node.id}: a ${node.kind} step makes no model call and must have no model`);
      continue;
    }

    if (node.model === null) {
      reasons.push(`step ${node.id}: a ${node.kind} step needs a live ${expected} model, and none was chosen`);
      continue;
    }
    const entry = catalog.get(node.model.id);
    if (!entry) {
      reasons.push(`step ${node.id}: ${node.model.id} is not in the live catalog`);
      continue;
    }
    if (entry.kind !== expected) {
      reasons.push(`step ${node.id}: ${node.model.id} is a ${entry.kind} model, and a ${node.kind} step needs a ${expected} model`);
      continue;
    }
    if (node.estimateUsd === null) {
      reasons.push(`step ${node.id}: no cost estimate, so the step does not run`);
      continue;
    }
    paidTotal += node.estimateUsd;
  }

  if (paidTotal > plan.budgetUsd) {
    reasons.push(`estimated cost $${paidTotal.toFixed(4)} exceeds the budget $${plan.budgetUsd.toFixed(4)}`);
  }

  const order = topologicalOrder(plan.nodes);
  if (order === null) reasons.push("the steps have a cycle, so there is no order to run them in");

  if (reasons.length > 0 || order === null) return { ok: false, reasons };
  return { ok: true, order };
}

/** The steps a plan's steps need, for the message a reviewer reads. Pure. */
export function describeNode(node: PlanNode): string {
  return node.model ? `${node.kind} on ${node.model.id}` : node.kind;
}
