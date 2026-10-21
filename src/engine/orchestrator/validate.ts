// Checks a plan before any step runs, and prices it. Pure: the plan and the live catalog in, the reasons out or the checked plan. A plan
// that fails any check does not run at all (fail closed). Every reason names the step it is about, so the canvas can point at it.
//
// Cost is the engine's, never the model's. Each paid step is priced from its model's live price in the catalog (priceStep). The
// plan's own estimateUsd is advisory and is overwritten: a model that understates its cost cannot pass the budget check. A step whose
// model has no usable price in the listing, or whose parameters do not give a basis for the price, does not run.

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

/** The limits on what a step may ask for. A parameter outside them is a reason, never a clamp. */
export const PRICING_LIMITS = {
  maxSeconds: 60,
  maxInputTokens: 200_000,
  maxOutputTokens: 32_000,
  defaultInputTokens: 6_000,
  defaultOutputTokens: 2_000,
  maxCharacters: 20_000,
  /** Speech is priced per prompt token. The listing does not give a tokeniser, so characters are counted as at most three per token. */
  charactersPerSpeechToken: 3,
} as const;

export type ValidationResult = { ok: true; order: string[]; plan: OrchestratorPlan } | { ok: false; reasons: string[] };

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

type Priced = { usd: number } | { reason: string };

/** A whole-number parameter within a range, or the default when the parameter is absent. */
function countParam(node: PlanNode, name: string, fallback: number, max: number): number | { reason: string } {
  const value = node.params[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    return { reason: `step ${node.id}: params.${name} must be a whole number from 1 to ${max}` };
  }
  return value;
}

/** The engine's cost for one paid step, from its model's live price. The reason says what is missing when there is no price basis. */
export function priceStep(node: PlanNode, entry: CatalogEntry): Priced {
  const price = entry.pricing;
  switch (node.kind) {
    case "video":
    case "avatar": {
      const seconds = node.params.seconds;
      if (typeof seconds !== "number" || !(seconds > 0) || seconds > PRICING_LIMITS.maxSeconds) {
        return { reason: `step ${node.id}: params.seconds must be a number from 0 to ${PRICING_LIMITS.maxSeconds}` };
      }
      if (price.usdPerSecond1080p === null) return { reason: `step ${node.id}: ${entry.id} has no per-second price in the listing` };
      return { usd: price.usdPerSecond1080p * seconds };
    }
    case "visual": {
      if (price.imageUsd === null) return { reason: `step ${node.id}: ${entry.id} has no per-image price in the listing` };
      return { usd: price.imageUsd };
    }
    case "analysis":
    case "script": {
      const input = countParam(node, "input_tokens", PRICING_LIMITS.defaultInputTokens, PRICING_LIMITS.maxInputTokens);
      if (typeof input !== "number") return input;
      const output = countParam(node, "max_tokens", PRICING_LIMITS.defaultOutputTokens, PRICING_LIMITS.maxOutputTokens);
      if (typeof output !== "number") return output;
      if (price.promptUsdPerToken === null || price.completionUsdPerToken === null) {
        return { reason: `step ${node.id}: ${entry.id} has no per-token price in the listing` };
      }
      return { usd: input * price.promptUsdPerToken + output * price.completionUsdPerToken };
    }
    case "voice": {
      const characters = node.params.characters;
      if (typeof characters !== "number" || !Number.isInteger(characters) || characters < 1 || characters > PRICING_LIMITS.maxCharacters) {
        return { reason: `step ${node.id}: params.characters must be a whole number from 1 to ${PRICING_LIMITS.maxCharacters}` };
      }
      if (price.promptUsdPerToken === null) return { reason: `step ${node.id}: ${entry.id} has no per-token price in the listing` };
      const tokens = Math.ceil(characters / PRICING_LIMITS.charactersPerSpeechToken);
      return { usd: tokens * price.promptUsdPerToken };
    }
    default:
      return { reason: `step ${node.id}: a ${node.kind} step has no price` };
  }
}

/** Validate a parsed plan against the live catalog, price it, and return it with the engine's costs in place. */
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

  const costs = new Map<string, number>();
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
    const priced = priceStep(node, entry);
    if ("reason" in priced) {
      reasons.push(priced.reason);
      continue;
    }
    costs.set(node.id, priced.usd);
  }

  const paidTotal = [...costs.values()].reduce((sum, usd) => sum + usd, 0);
  if (paidTotal > plan.budgetUsd) {
    reasons.push(`estimated cost $${paidTotal.toFixed(4)} exceeds the budget $${plan.budgetUsd.toFixed(4)}`);
  }

  const order = topologicalOrder(plan.nodes);
  if (order === null) reasons.push("the steps have a cycle, so there is no order to run them in");

  if (reasons.length > 0 || order === null) return { ok: false, reasons };

  const priced = plan.nodes.map((node) => ({ ...node, estimateUsd: costs.get(node.id) ?? null }));
  return { ok: true, order, plan: { ...plan, nodes: priced } };
}

/** The steps a plan's steps need, for the message a reviewer reads. Pure. */
export function describeNode(node: PlanNode): string {
  return node.model ? `${node.kind} on ${node.model.id}` : node.kind;
}
