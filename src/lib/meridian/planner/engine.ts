import { variantMatrix, templateFromDna, type StoryboardTemplate, type VariantAxis } from "../factory/template.ts";
import type { CreativeDna } from "../factory/creative-dna.ts";

export type VariantPlanningInput = {
  hooks: string[];
  ctas: string[];
  presenters?: string[];
  lengthsMs?: number[];
  problems?: string[];
  visuals?: string[];
  offers?: string[];
  maxVariants?: number;
};

export type VariantPlanningResult = {
  engineId: string;
  totalCombinations: number;
  variants: VariantAxis[];
};

export type TemplatePlanningResult = {
  engineId: string;
  template: StoryboardTemplate;
};

export type PlannerEngine = {
  id: string;
  name: string;
  description: string;
  planVariants(input: VariantPlanningInput): Promise<VariantPlanningResult>;
  planFromDna(dna: CreativeDna): Promise<TemplatePlanningResult>;
};

export function matrixPlannerEngine(): PlannerEngine {
  return {
    id: "matrix",
    name: "Combinatorial Matrix Planner",
    description: "Generates multi-arm variant permutations across hooks, visual directions, offers, and CTAs.",
    async planVariants(input: VariantPlanningInput): Promise<VariantPlanningResult> {
      const presenters = input.presenters && input.presenters.length > 0 ? input.presenters : ["creator"];
      const lengthsMs = input.lengthsMs && input.lengthsMs.length > 0 ? input.lengthsMs : [6000];
      const variants = variantMatrix({
        hooks: input.hooks,
        ctas: input.ctas,
        presenters,
        lengthsMs,
        max: input.maxVariants ?? 12,
      });
      const totalCombinations =
        input.hooks.length *
        input.ctas.length *
        presenters.length *
        lengthsMs.length;

      return {
        engineId: "matrix",
        totalCombinations,
        variants,
      };
    },
    async planFromDna(dna: CreativeDna): Promise<TemplatePlanningResult> {
      const template = templateFromDna(dna);
      return {
        engineId: "matrix",
        template,
      };
    },
  };
}

const customPlannerEngines = new Map<string, PlannerEngine>();

export function registerPlannerEngine(engine: PlannerEngine): void {
  customPlannerEngines.set(engine.id, engine);
}

export function plannerEngineById(id: string): PlannerEngine {
  if (customPlannerEngines.has(id)) {
    return customPlannerEngines.get(id)!;
  }
  if (id === "matrix") return matrixPlannerEngine();
  throw new Error(`Unknown planner engine "${id}". Supported: matrix.`);
}
