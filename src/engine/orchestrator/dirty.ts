// Cache keys for surgical re-runs. A step's key is a hash of what decides its output (kind, model, params and the keys of the steps it
// reads). Title and wording do not enter it, so renaming a step does not cost a call. Which steps are stale after an edit is in stale.ts,
// which has no Node-only imports and runs in the browser too.

import { contentHash } from "../contracts/hash.ts";
import type { OrchestratorPlan } from "./contracts.ts";

export { editNode, staleSet, type NodeChange } from "./stale.ts";

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
