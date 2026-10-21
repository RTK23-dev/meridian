// Surgical edits, without hashing: the change to one step and the steps that must run again because of it. Pure, and free of Node-only
// imports, so the canvas can use it in the browser. The cache keys that decide what a re-run really reuses are in dirty.ts.

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
