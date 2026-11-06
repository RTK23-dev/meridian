// Definition of character.rig for the component library (Bible 9.2, 13 CharacterSheet, used by cartoon_rigged shots). The rig
// is drawn by its template from fixed parts and a fixed pose library; no pixels are generated or fetched.

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/character.rig/component.html");

export const characterRig: ComponentDefinition = {
  name: "character.rig",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["rigId", "characterId", "position", "durationMs"],
  fixtures,
};
