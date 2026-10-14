// Definition of cta.card for the component library (Bible 9.2, used by endings).

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const ctaCard: ComponentDefinition = {
  name: "cta.card",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["text", "keyword", "arrow", "durationMs"],
  fixtures,
};
