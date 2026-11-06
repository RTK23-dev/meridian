// Definition of kinetic.punchline for the component library (Bible 9.2, used by kinetic_type shots).

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/kinetic.punchline/component.html");

export const kineticPunchline: ComponentDefinition = {
  name: "kinetic.punchline",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["rhythmMs", "scale", "durationMs"],
  fixtures,
};
