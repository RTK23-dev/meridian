// Definition of cta.follow for the component library (round 3, K21): a follow prompt pill with a handle, in the lower band.

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/cta.follow/component.html");

export const ctaFollow: ComponentDefinition = {
  name: "cta.follow",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["handle", "prompt", "durationMs"],
  fixtures,
};
