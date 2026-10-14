// The task inputs of the two Opus roles of the plan (Bible 11.1, 11.2 part 3): the planner (step 4) and the director (step 5).
// Pure. Each builder returns the role's input and nothing else. The script's words are never in either input: a visual choice
// needs the beat's role and the viewer's requests, and a prompt must not carry words to render (L8). The persona and character
// fields are the kits' own visual descriptions. No product name, claim, price or fetched text is in either input.

import type { CharacterSheet, GeneId, Persona, ProductKit, StyleKit, VisualType } from "../contracts/index.ts";
import type { PlannerInput, PlannerShot } from "../claude/roles/planner.ts";
import type { DirectorCheckInput, DirectorShot } from "../claude/roles/director_check.ts";

/** The page's visual style: the palette and the motion intensity. Colours and numbers only. */
export function styleFor(styleKit: StyleKit): { palette: Record<string, string>; motionIntensity: 0 | 1 | 2 | 3 } {
  return {
    palette: { ...styleKit.palette },
    motionIntensity: styleKit.motionIntensity,
  };
}

/** The page's characters: the kind, the style notes and the number of reference images each sends. Never a name. */
export function charactersFor(characters: readonly CharacterSheet[]): PlannerInput["characters"] {
  return characters.map((character) => ({
    kind: character.kind,
    ...(character.styleNotes === undefined ? {} : { styleNotes: character.styleNotes }),
    referenceCount: character.references?.length ?? 0,
  }));
}

export function plannerTaskOf(input: {
  styleKit: StyleKit;
  persona?: Persona;
  characters: readonly CharacterSheet[];
  productKit?: ProductKit;
  shots: readonly PlannerShot[];
}): PlannerInput {
  return {
    style: styleFor(input.styleKit),
    ...(input.persona === undefined
      ? {}
      : {
          persona: {
            description: input.persona.description,
            wardrobe: input.persona.wardrobe,
            setting: input.persona.setting,
          },
        }),
    characters: charactersFor(input.characters),
    productColours: input.productKit === undefined ? [] : [...input.productKit.colours],
    shots: [...input.shots],
  };
}

export function directorTaskOf(input: {
  requestBudgetUsd: number;
  reservedUsd: number;
  genome: Partial<Record<GeneId, string>>;
  persona?: Persona;
  shots: readonly DirectorShot[];
}): DirectorCheckInput {
  return {
    requestBudgetUsd: input.requestBudgetUsd,
    reservedUsd: input.reservedUsd,
    genome: { ...input.genome },
    ...(input.persona === undefined ? {} : { persona: { description: input.persona.description } }),
    shots: [...input.shots],
  };
}

/** The visual types a shot can be built as that need a written generation prompt (a generated type). */
export function needsPrompt(candidates: readonly { generated: boolean }[]): boolean {
  return candidates.some((candidate) => candidate.generated);
}

/** The visual types that need a stock search query (stock footage). */
export function needsQuery(visualTypes: readonly VisualType[]): boolean {
  return visualTypes.includes("stock_footage");
}
