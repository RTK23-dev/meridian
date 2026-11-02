// Definition of stat.counter for the component library (round 3, K21): a count that rises over the clip, with a pill label.

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const statCounter: ComponentDefinition = {
  name: "stat.counter",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["value", "label", "decimals", "prefix", "suffix", "durationMs"],
  fixtures,
};
