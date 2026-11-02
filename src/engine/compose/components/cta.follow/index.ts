// Definition of cta.follow for the component library (round 3, K21): a follow prompt pill with a handle, in the lower band.

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const ctaFollow: ComponentDefinition = {
  name: "cta.follow",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["handle", "prompt", "durationMs"],
  fixtures,
};
