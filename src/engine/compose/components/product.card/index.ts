// Definition of product.card for the component library (Bible 9.2: product downgrade target).

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const productCard: ComponentDefinition = {
  name: "product.card",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["name", "price", "heroUri", "durationMs"],
  fixtures,
};
