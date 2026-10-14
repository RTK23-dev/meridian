// Definition of compare.split for the component library (Bible 9.2, comparisons).

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const compareSplit: ComponentDefinition = {
  name: "compare.split",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["leftLabel", "rightLabel", "leftUri", "rightUri", "revealMs", "durationMs"],
  fixtures,
};
