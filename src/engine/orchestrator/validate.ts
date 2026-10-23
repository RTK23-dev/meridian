// Checks a plan before any step runs, and prices it. Pure: the plan and the live catalog in, the reasons out or the checked plan. A plan
// that fails any check does not run at all (fail closed). Every reason names the step it is about, so the canvas can point at it.
//
// Cost is the engine's, never the model's. Each paid step is priced from its model's live price in the catalog (priceStep). The
// plan's own estimateUsd is advisory and is overwritten: a model that understates its cost cannot pass the budget check. A step whose
// model has no usable price in the listing, or whose parameters do not give a basis for the price, does not run.

import { isDisabledModel } from "../config/model-policy.ts";
import { positionOfLine, type BudgetPosition } from "../budget/line.ts";
import { BUDGET_CATEGORIES, categoryOf, type BudgetCategory, type CategoryAmounts } from "./categories.ts";
import type { CatalogEntry, CatalogKind } from "./catalog.ts";
import type { NodeKind, OrchestratorPlan, PlanNode } from "./contracts.ts";
import { holdUsdOf, type MeasureOptions } from "./measure.ts";

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

/** The plan's money against its line (D12, envelope.ts lineOf). A plan above its line is still a plan: the run stops at the line. */
export type BudgetView = { estimateUsd: number; budgetUsd: number; position: BudgetPosition };

/** One category's money against its own envelope, for each category the brief sets (categories.ts). */
export type CategoryView = BudgetView & { category: BudgetCategory };

/**
 * A checked plan. `notes` say what is accepted with a note rather than refused: an estimate above its line (the run stops at the first step
 * that does not fit, D17). A plan that is over its line is still a plan.
 */
export type ValidationResult =
  | { ok: true; order: string[]; plan: OrchestratorPlan; budget: BudgetView; categories: CategoryView[]; notes: string[] }
  | { ok: false; reasons: string[] };

/** A model id that is an alias (a ~ id, or one with "latest" in it) is not pinned: the same id can mean a different model next week. */
export function isAliasModelId(id: string): boolean {
  return id.startsWith("~") || id.toLowerCase().includes("latest");
}

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

/**
 * A step's price: its cost, why it has none (the step is refused), or that it needs measure mode (a planning note, D15). A step that needs
 * measure mode has no cost until a run in measure mode gives it a hold.
 */
type Priced = { usd: number } | { reason: string } | { needsMeasure: string };

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
export function priceStep(node: PlanNode, entry: CatalogEntry, options: ValidateOptions = {}): Priced {
  const price = entry.pricing;
  switch (node.kind) {
    case "video":
    case "avatar": {
      const seconds = node.params.seconds;
      if (typeof seconds !== "number" || !(seconds > 0) || seconds > PRICING_LIMITS.maxSeconds) {
        return { reason: `step ${node.id}: params.seconds must be a number from 0 to ${PRICING_LIMITS.maxSeconds}` };
      }
      if (price.usdPerSecond1080p === null) {
        // Measure mode (D15): the hold is the ceiling times the length. The plan's own estimate is advisory and is not read here.
        const measured = holdUsdOf({ ...node, estimateUsd: null }, options.measure ?? null);
        if (measured !== null) return { usd: measured };
        // Planning (D15): the plan is stored with a note, and the step has no cost. The run refuses it until a run in measure mode holds it.
        if (options.planning === true) {
          return { needsMeasure: `step ${node.id}: ${entry.id} has no per-second price in the listing, so the step needs measure mode; it does not run until a run in measure mode holds it` };
        }
        return { reason: `step ${node.id}: ${entry.id} has no per-second price in the listing, so the step needs measure mode, which an admin starts` };
      }
      return { usd: price.usdPerSecond1080p * seconds };
    }
    case "visual": {
      if (price.imageUsd === null) return { reason: `step ${node.id}: ${entry.id} has no per-image price in the listing` };
      return { usd: price.imageUsd };
    }
    case "analysis":
    case "script": {
      const claimed = countParam(node, "input_tokens", PRICING_LIMITS.defaultInputTokens, PRICING_LIMITS.maxInputTokens);
      if (typeof claimed !== "number") return claimed;
      const input = Math.min(PRICING_LIMITS.maxInputTokens, Math.max(claimed, options.textInputTokens ?? 0));
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
/** The input tokens a text step is bounded to on the server: the brief's size, plus the instructions the step adds (review 2026-10-22, item 3). */
const TEXT_STEP_OVERHEAD_TOKENS = 1000;

export function textInputTokensOf(brief: unknown): number {
  const characters = JSON.stringify(brief ?? null).length;
  return Math.min(PRICING_LIMITS.maxInputTokens, Math.ceil(characters / 3) + TEXT_STEP_OVERHEAD_TOKENS);
}

export type ValidateOptions = {
  /**
   * The server's bound on a text step's input tokens (textInputTokensOf the stored brief). A plan's own figure may raise the bound, never lower
   * it, so a model cannot understate what its text steps cost.
   */
  textInputTokens?: number;
  /** The model families the workspace has switched off (owner direction 2026-10-23). A model of one is refused with that reason, not as unlisted. */
  disabledFamilies?: readonly string[];
  /** The plan's line (D12): the lower of its budget and the budget the user set. Absent: the plan's own budget. */
  budgetUsd?: number;
  /** The line of each category the brief sets (categories.ts categoryBudgetsOf). A category without one has no check of its own. */
  categoryBudgetsUsd?: CategoryAmounts;
  /** Measure mode (D15): a video or avatar step with no engine price is held to its ceiling and may run. Absent or null: off. */
  measure?: MeasureOptions | null;
  /**
   * Planning (D15): a video or avatar step with no engine price, and no measure mode, is not refused. The plan is stored with a note that the
   * step needs measure mode, and the step has no cost. The run still refuses such a plan until a run in measure mode holds the step. Every
   * other unpriced step is still refused.
   */
  planning?: boolean;
};

/**
 * Whether the engine can price a step of the entry's kind from the listing: the same fields priceStep reads. A model the listing does not
 * price is not offered as a candidate, because a step that uses it is refused.
 */
export function hasPriceBasis(entry: CatalogEntry): boolean {
  const { pricing } = entry;
  switch (entry.kind) {
    case "text":
      return pricing.promptUsdPerToken !== null && pricing.completionUsdPerToken !== null;
    case "speech":
      return pricing.promptUsdPerToken !== null;
    case "image":
      return pricing.imageUsd !== null;
    case "video":
      return pricing.usdPerSecond1080p !== null;
    default:
      return false;
  }
}

/** Why a model id is not a candidate: switched off by the workspace's policy, or not in the live catalog. */
export function listingReason(id: string, disabledFamilies: readonly string[]): string {
  return isDisabledModel(id, disabledFamilies) ? `${id} is switched off by the workspace's model policy` : `${id} is not in the live catalog`;
}

export function validatePlan(plan: OrchestratorPlan, catalog: Map<string, CatalogEntry>, options: ValidateOptions = {}): ValidationResult {
  const reasons: string[] = [];

  const orchestrator = catalog.get(plan.orchestrator.id);
  if (isAliasModelId(plan.orchestrator.id)) reasons.push(`orchestrator ${plan.orchestrator.id}: the model id is an alias, not a pinned id`);
  if (!orchestrator) reasons.push(`orchestrator ${listingReason(plan.orchestrator.id, options.disabledFamilies ?? [])}`);
  else if (orchestrator.kind !== "text") reasons.push(`orchestrator ${plan.orchestrator.id} is a ${orchestrator.kind} model, not a text model`);

  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (ids.has(node.id)) reasons.push(`step ${node.id}: duplicate id`);
    ids.add(node.id);
  }

  const costs = new Map<string, number>();
  const notes: string[] = [];
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
    if (isAliasModelId(node.model.id)) {
      reasons.push(`step ${node.id}: the model id is an alias, not a pinned id`);
      continue;
    }
    const entry = catalog.get(node.model.id);
    if (!entry) {
      reasons.push(`step ${node.id}: ${listingReason(node.model.id, options.disabledFamilies ?? [])}`);
      continue;
    }
    if (entry.kind !== expected) {
      reasons.push(`step ${node.id}: ${node.model.id} is a ${entry.kind} model, and a ${node.kind} step needs a ${expected} model`);
      continue;
    }
    const priced = priceStep(node, entry, options);
    if ("reason" in priced) {
      reasons.push(priced.reason);
      continue;
    }
    if ("needsMeasure" in priced) {
      notes.push(priced.needsMeasure);
      continue;
    }
    costs.set(node.id, priced.usd);
  }

  // The plan's money is placed against its line: within it, or over it. A plan over its line is still a plan, and the run stops at the line
  // (execute.ts). A measured step's hold is part of the estimate (D15).
  const paidTotal = [...costs.values()].reduce((sum, usd) => sum + usd, 0);
  const lineUsd = options.budgetUsd ?? plan.budgetUsd;
  const budget: BudgetView = { estimateUsd: paidTotal, budgetUsd: lineUsd, position: positionOfLine(paidTotal, lineUsd) };

  // Each category the brief sets is summed from its own steps and placed against its own line. The same rule as the total.
  const categories: CategoryView[] = [];
  for (const category of BUDGET_CATEGORIES) {
    const categoryLine = options.categoryBudgetsUsd?.[category];
    if (categoryLine === undefined) continue;
    let estimateUsd = 0;
    for (const node of plan.nodes) if (categoryOf(node.kind) === category) estimateUsd += costs.get(node.id) ?? 0;
    categories.push({ category, estimateUsd, budgetUsd: categoryLine, position: positionOfLine(estimateUsd, categoryLine) });
  }

  // A plan or a category whose estimate is above its line is accepted with a note (D17). The run stops at the first step that does not fit.
  if (budget.position === "over_budget") {
    notes.push(`the plan's estimate of $${paidTotal.toFixed(4)} is above its $${lineUsd.toFixed(4)} budget; the run stops at the first step that does not fit`);
  }
  for (const view of categories) {
    if (view.position === "over_budget") {
      notes.push(
        `the ${view.category} steps' estimate of $${view.estimateUsd.toFixed(4)} is above their $${view.budgetUsd.toFixed(4)} ${view.category} budget; the run stops at the first ${view.category} step that does not fit`,
      );
    }
  }

  const order = topologicalOrder(plan.nodes);
  if (order === null) reasons.push("the steps have a cycle, so there is no order to run them in");

  if (reasons.length > 0 || order === null) return { ok: false, reasons };

  const priced = plan.nodes.map((node) => ({ ...node, estimateUsd: costs.get(node.id) ?? null }));
  return { ok: true, order, plan: { ...plan, nodes: priced }, budget, categories, notes };
}

/** The steps a plan's steps need, for the message a reviewer reads. Pure. */
export function describeNode(node: PlanNode): string {
  return node.model ? `${node.kind} on ${node.model.id}` : node.kind;
}
