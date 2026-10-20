// Surgical edits. A change to one step makes that step and every step downstream of it stale; nothing else. The cache key of a step
// is a hash of what decides its output (kind, model, params and the keys of the steps it reads). Title and wording do not enter
// it, so renaming a step on the canvas does not cost a call. Pure.

import { contentHash } from "../contracts/hash.ts";
import type { ModelRef, OrchestratorPlan } from "./contracts.ts";

export type NodeChange = {
  params?: OrchestratorPlan["nodes"][number]["params"];
  model?: ModelRef | null;
  estimateUsd?: number | null;
};

/** The steps that must run again when `changed` steps change: the changed steps and everything downstream of them. */
export function staleSet(plan: OrchestratorPlan, changed: string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of plan.nodes) {
    for (const dep of node.dependsOn) children.set(dep, [...(children.get(dep) ?? []), node.id]);
  }
  const stale = new Set<string>();
  const stack = [...changed];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || stale.has(id)) continue;
    stale.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return stale;
}

/** A copy of the plan with one step changed. Every other step is the same object. Throws when the step does not exist. */
export function editNode(plan: OrchestratorPlan, nodeId: string, change: NodeChange): OrchestratorPlan {
  if (!plan.nodes.some((node) => node.id === nodeId)) throw new Error(`no step ${nodeId} in this plan`);
  return {
    ...plan,
    nodes: plan.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      return {
        ...node,
        params: change.params ?? node.params,
        model: change.model !== undefined ? change.model : node.model,
        estimateUsd: change.estimateUsd !== undefined ? change.estimateUsd : node.estimateUsd,
      };
    }),
  };
}

/**
 * The cache key of each step, in `order`. A key covers the step's kind, model, params and the keys of the steps it reads, so a
 * step's key changes exactly when something it depends on changes. Pure.
 */
export function cacheKeys(plan: OrchestratorPlan, order: string[]): Map<string, string> {
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const keys = new Map<string, string>();
  for (const id of order) {
    const node = byId.get(id);
    if (!node) throw new Error(`no step ${id} in this plan`);
    const upstream = [...node.dependsOn].sort().map((dep) => [dep, keys.get(dep) ?? null]);
    keys.set(
      id,
      contentHash({
        kind: node.kind,
        model: node.model?.id ?? null,
        params: node.params,
        upstream,
      }),
    );
  }
  return keys;
}
