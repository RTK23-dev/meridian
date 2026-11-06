// Directed, not described (direction lessons L1, L2, L23): the orchestrator's plan should put a Director step before every picture step,
// a fact-check step between the Director and the crew, and name, on every picture step, the shot of the direction it builds. A plan
// that does not is still accepted, with a note, so the person sees that its pictures are described: the run is the person's to make,
// and no budget or rule refuses a plan on direction alone.
//
// The step kinds and params are the plan's existing contract (contracts.ts): a Director is a `script` step with params.role "director",
// a fact-checker an `analysis` step with params.role "fact_checker", and a picture step names its shot in params.shot.

import type { OrchestratorPlan, PlanNode } from "./contracts.ts";

const PICTURE_KINDS = new Set(["visual", "video", "avatar"]);

export function isDirector(node: PlanNode): boolean {
  return node.kind === "script" && node.params.role === "director";
}

export function isFactChecker(node: PlanNode): boolean {
  return node.kind === "analysis" && node.params.role === "fact_checker";
}

/** Every step a step reads, directly or through other steps. */
function upstreamOf(plan: OrchestratorPlan, id: string): Set<string> {
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const stack = [...(byId.get(id)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byId.get(next)?.dependsOn ?? []));
  }
  return seen;
}

/** The notes a plan carries about its direction. Empty for a directed plan, or for a plan that makes no picture. */
export function directionNotes(plan: OrchestratorPlan): string[] {
  const pictures = plan.nodes.filter((node) => PICTURE_KINDS.has(node.kind));
  if (pictures.length === 0) return [];
  const directors = plan.nodes.filter(isDirector).map((node) => node.id);
  if (directors.length === 0) {
    return [
      "the picture steps are described, not directed: no Director step (a script step with params.role \"director\") writes the shot direction before them (L1, L2)",
    ];
  }
  const notes: string[] = [];
  const checkers = plan.nodes.filter(isFactChecker).map((node) => node.id);
  for (const picture of pictures) {
    const upstream = upstreamOf(plan, picture.id);
    if (!directors.some((id) => upstream.has(id))) {
      notes.push(`step ${picture.id}: makes a picture with no Director step upstream, so it is described, not directed (L2)`);
      continue;
    }
    if (typeof picture.params.shot !== "string" || picture.params.shot.length === 0) {
      notes.push(`step ${picture.id}: does not name the shot of the direction it builds (params.shot) (L1)`);
    }
    if (!checkers.some((id) => upstream.has(id))) {
      notes.push(`step ${picture.id}: no fact-check step stands between the Director and this picture (L23)`);
    }
  }
  return notes;
}
