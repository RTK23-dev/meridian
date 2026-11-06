// Definition of product.card for the component library (Bible 9.2: product downgrade target).

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/product.card/component.html");

export const productCard: ComponentDefinition = {
  name: "product.card",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["name", "price", "heroUri", "durationMs"],
  fixtures,
};
