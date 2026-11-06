// Definition of cta.card for the component library (Bible 9.2, used by endings).

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/cta.card/component.html");

export const ctaCard: ComponentDefinition = {
  name: "cta.card",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["text", "keyword", "arrow", "durationMs"],
  fixtures,
};
