// Definition of price.reveal for the component library (Bible 9.2, offers).

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/price.reveal/component.html");

export const priceReveal: ComponentDefinition = {
  name: "price.reveal",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["oldText", "newText", "revealMs", "caption", "durationMs"],
  fixtures,
};
