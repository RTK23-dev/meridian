// Definition of price.reveal for the component library (Bible 9.2, offers).

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const priceReveal: ComponentDefinition = {
  name: "price.reveal",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["oldText", "newText", "revealMs", "caption", "durationMs"],
  fixtures,
};
