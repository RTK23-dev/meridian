// Definition of label.pill for the component library (round 3, K21): the place and date of a clip, in a pill at the top of the frame.

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/label.pill/component.html");

export const labelPill: ComponentDefinition = {
  name: "label.pill",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["place", "date", "durationMs"],
  fixtures,
};
