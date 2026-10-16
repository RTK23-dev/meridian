// Definition of kinetic.type for the component library (Bible 9.2, beyond kinetic.punchline). Used by kinetic_type shots
// that carry emphasis words.

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const kineticType: ComponentDefinition = {
  name: "kinetic.type",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["entrance", "wordStepMs", "band", "durationMs"],
  fixtures,
};
