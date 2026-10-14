// Definition of kinetic.punchline for the component library (Bible 9.2, used by kinetic_type shots).

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const kineticPunchline: ComponentDefinition = {
  name: "kinetic.punchline",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["rhythmMs", "scale", "durationMs"],
  fixtures,
};
