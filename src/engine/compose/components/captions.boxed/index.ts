// Definition of captions.boxed for the component library (round 3, K21): the captions of captions.karaoke, with the spoken word in a filled box.

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const captionsBoxed: ComponentDefinition = {
  name: "captions.boxed",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["band", "durationMs"],
  fixtures,
};
