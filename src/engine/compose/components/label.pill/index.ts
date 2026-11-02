// Definition of label.pill for the component library (round 3, K21): the place and date of a clip, in a pill at the top of the frame.

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const labelPill: ComponentDefinition = {
  name: "label.pill",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["place", "date", "durationMs"],
  fixtures,
};
