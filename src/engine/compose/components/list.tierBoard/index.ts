// Definition of list.tierBoard for the component library (Bible 9.2, tier-list formats).

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/list.tierBoard/component.html");

export const listTierBoard: ComponentDefinition = {
  name: "list.tierBoard",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["title", "durationMs"],
  fixtures,
};
