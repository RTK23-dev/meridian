// Definition of captions.boxed for the component library (round 3, K21): the captions of captions.karaoke, with the spoken word in a filled box.

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/captions.boxed/component.html");

export const captionsBoxed: ComponentDefinition = {
  name: "captions.boxed",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["band", "durationMs"],
  fixtures,
};
