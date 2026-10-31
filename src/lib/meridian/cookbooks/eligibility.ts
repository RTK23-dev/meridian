// Eligibility (round 3, K9): from what a person has supplied, which cookbooks can run at all, and why the others cannot. Pure, and read from the
// cookbook's own ingredients, so no cookbook needs a special case. The selector (K10) only chooses among the eligible ones.
//
// The rule for each required ingredient: it can be met when one of its ways is available to this run.
//   - a coded way is always available;
//   - an upload is available when the person supplied that kind of file (voice, footage, a product kit, a reference);
//   - a paid way (a model class or a visual type) is available only with a known budget above zero, and only in engine mode.
// An unknown budget (null) is not a budget: paid ways stay unavailable, so the answer never assumes spend (CLAUDE.md rule 1).

import type { Cookbook, Ingredient, Way } from "./schema.ts";

export type RunInputs = {
  /** The brief's length in characters. Not a requirement on its own: a reference-led run may have no brief. */
  briefChars: number;
  /** A reference video was attached, and whether its Video DNA is already cached for this format. */
  reference: { attached: boolean; dnaCached: boolean };
  /** A product kit was chosen for this run. */
  productKit: boolean;
  /** Files the person supplied, by what they are. */
  uploads: { voice: boolean; footage: boolean; music: boolean };
  /** The run's budget in USD. Null when the budget is not set. */
  budgetUsd: number | null;
  /** normal: a person chooses. automated_loop: the pick is accepted as it is (K11). */
  runKind: "normal" | "automated_loop";
};

export type WayAvailability = { available: true; paid: boolean } | { available: false; reason: string };

export type Eligibility = {
  cookbookId: string;
  label: string;
  /** Whether the cookbook can run at all with these inputs. */
  eligible: boolean;
  /** The modes this run could use: agent needs every chosen way to be free. */
  modes: Array<"agent" | "engine">;
  /** Why it cannot run, one line per unmet need. Empty when it can. */
  reasons: string[];
};

const HAS_BUDGET = (inputs: RunInputs) => inputs.budgetUsd !== null && inputs.budgetUsd > 0;

/** Whether one way of an ingredient can be used in this run, and whether it spends money. */
export function wayAvailability(way: Way, ingredient: Ingredient, inputs: RunInputs): WayAvailability {
  if (way.coded === true) return { available: true, paid: false };
  if (way.upload === true) {
    const supplied = supplies(ingredient, inputs);
    return supplied ? { available: true, paid: false } : { available: false, reason: `${ingredient.label} needs your file` };
  }
  if (!HAS_BUDGET(inputs)) {
    return { available: false, reason: `${way.label} costs money, and no budget is set` };
  }
  return { available: true, paid: true };
}

/** Whether the person supplied what an ingredient's upload way is for. */
function supplies(ingredient: Ingredient, inputs: RunInputs): boolean {
  switch (ingredient.kind) {
    case "voice":
      return inputs.uploads.voice;
    case "music":
      return inputs.uploads.music;
    case "ugc_footage":
    case "presenter":
    case "stock":
      return inputs.uploads.footage;
    case "product_kit":
      return inputs.productKit;
    case "reference":
      return inputs.reference.attached;
    default:
      return false;
  }
}

/** Whether a cookbook can run with these inputs, and which modes it could run in. */
export function eligibilityFor(cookbook: Cookbook, inputs: RunInputs): Eligibility {
  const reasons: string[] = [];
  const freeOnly: Record<string, boolean> = {};
  for (const ingredient of cookbook.ingredients) {
    if (ingredient.need !== "required") continue;
    const options = ingredient.ways.map((way) => wayAvailability(way, ingredient, inputs));
    const usable = options.filter((option): option is { available: true; paid: boolean } => option.available);
    if (usable.length === 0) {
      const why = options.map((option) => (option.available ? "" : option.reason)).filter((text) => text !== "");
      reasons.push(`${ingredient.label}: ${why.join("; ") || "no way is available"}`);
    }
    freeOnly[ingredient.id] = usable.some((option) => !option.paid);
  }
  const eligible = reasons.length === 0;
  const requiredAllFree = cookbook.ingredients.every((ingredient) => ingredient.need !== "required" || freeOnly[ingredient.id] === true);
  const modes: Array<"agent" | "engine"> = [];
  if (eligible && cookbook.modes.includes("agent") && requiredAllFree) modes.push("agent");
  if (eligible && cookbook.modes.includes("engine")) modes.push("engine");
  return { cookbookId: cookbook.cookbookId, label: cookbook.label, eligible, modes, reasons };
}

/** Every cookbook of a list, checked against one set of inputs. Eligible ones come first, in their order. */
export function eligibilityOf(cookbooks: readonly Cookbook[], inputs: RunInputs): Eligibility[] {
  const checked = cookbooks.map((cookbook) => eligibilityFor(cookbook, inputs));
  return [...checked.filter((item) => item.eligible), ...checked.filter((item) => !item.eligible)];
}
