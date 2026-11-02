// A cookbook as the orchestrator's starting plan (round 3, K16). The resolved cookbook's steps become plan nodes, in dependency order, that
// validate against the orchestrator's own schema. The person's edits to a node are kept (a param changed, a title changed), and an edited node
// says so in its reason. A plan is sent to the orchestrator only after a selection record exists (K11): confirmed or changed in a normal run,
// auto-accepted in an automated loop. Models and prices are the planner's to fill in (a later prompt version); a skeleton has none.

import { orchestratorPlanSchema, planNodeSchema, type OrchestratorPlan, type PlanNode } from "../../../engine/orchestrator/contracts.ts";
import { topologicalOrder } from "../../../engine/orchestrator/validate.ts";
import type { ResolvedCookbook } from "./resolve.ts";
import type { SelectionRecord } from "./select.ts";

export type NodeEdit = { title?: string; params?: Record<string, string | number | boolean | null> };

/** The cookbook's plan skeleton: the resolved plan template as an orchestrator plan, with no models and no estimates yet. */
export function planSkeletonOf(resolved: ResolvedCookbook, input: { orchestrator: OrchestratorPlan["orchestrator"]; budgetUsd: number }): { ok: true; plan: OrchestratorPlan } | { ok: false; reasons: string[] } {
  const nodes: PlanNode[] = [];
  for (const node of resolved.planTemplate) {
    const parsed = planNodeSchema.safeParse(node);
    if (!parsed.success) return { ok: false, reasons: parsed.error.issues.map((issue) => `${node.id}: ${issue.message}`) };
    nodes.push(parsed.data);
  }
  if (topologicalOrder(nodes) === null) return { ok: false, reasons: ["the cookbook's steps depend on each other in a loop"] };
  const plan = { version: "orchestrator-plan@1" as const, orchestrator: input.orchestrator, budgetUsd: input.budgetUsd, nodes };
  const checked = orchestratorPlanSchema.safeParse(plan);
  if (!checked.success) return { ok: false, reasons: checked.error.issues.map((issue) => issue.message) };
  return { ok: true, plan: checked.data };
}

/**
 * The person's edits to the skeleton. An edit names a node of the skeleton; an unknown node is refused. An edited node keeps its own changes and
 * says it was edited, so the plan shows where the person changed the cookbook's suggestion.
 */
export function applyNodeEdits(plan: OrchestratorPlan, edits: Record<string, NodeEdit>): { ok: true; plan: OrchestratorPlan } | { ok: false; reasons: string[] } {
  const known = new Set(plan.nodes.map((node) => node.id));
  const reasons = Object.keys(edits).filter((id) => !known.has(id)).map((id) => `${id}: the plan has no such step`);
  if (reasons.length > 0) return { ok: false, reasons };
  const nodes = plan.nodes.map((node): PlanNode => {
    const edit = edits[node.id];
    if (edit === undefined) return node;
    return {
      ...node,
      title: edit.title ?? node.title,
      params: { ...node.params, ...(edit.params ?? {}) },
      why: `${node.why} (edited)`,
    };
  });
  const checked = orchestratorPlanSchema.safeParse({ ...plan, nodes });
  if (!checked.success) return { ok: false, reasons: checked.error.issues.map((issue) => issue.message) };
  return { ok: true, plan: checked.data };
}

/**
 * Whether a plan may be sent to the orchestrator: a selection must exist. A normal run needs a confirmed or changed selection; an automated
 * loop needs the auto-accepted one. Anything else is refused, so no plan is sent for a cookbook nobody chose.
 */
export function mayRequestPlan(selection: SelectionRecord | null, runKind: "normal" | "automated_loop"): { ok: true } | { ok: false; reason: string } {
  if (selection === null) return { ok: false, reason: "Choose a cookbook before the plan is sent." };
  if (runKind === "normal" && selection.how === "auto_accepted") return { ok: false, reason: "A person confirms the cookbook in a normal run." };
  if (runKind === "automated_loop" && selection.how !== "auto_accepted") return { ok: false, reason: "An automated loop sends only the auto-accepted cookbook." };
  return { ok: true };
}
