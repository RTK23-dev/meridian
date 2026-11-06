// Definition of kinetic.type for the component library (Bible 9.2, beyond kinetic.punchline). Used by kinetic_type shots
// that carry emphasis words.

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/kinetic.type/component.html");

export const kineticType: ComponentDefinition = {
  name: "kinetic.type",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["entrance", "wordStepMs", "band", "durationMs"],
  fixtures,
};
