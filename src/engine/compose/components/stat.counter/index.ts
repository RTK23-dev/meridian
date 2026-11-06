// Definition of stat.counter for the component library (round 3, K21): a count that rises over the clip, with a pill label.

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/stat.counter/component.html");

export const statCounter: ComponentDefinition = {
  name: "stat.counter",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["value", "label", "decimals", "prefix", "suffix", "durationMs"],
  fixtures,
};
