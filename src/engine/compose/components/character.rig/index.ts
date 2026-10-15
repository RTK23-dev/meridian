// Definition of character.rig for the component library (Bible 9.2, 13 CharacterSheet, used by cartoon_rigged shots). The rig
// is drawn by its template from fixed parts and a fixed pose library; no pixels are generated or fetched.

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const characterRig: ComponentDefinition = {
  name: "character.rig",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["rigId", "characterId", "position", "durationMs"],
  fixtures,
};
