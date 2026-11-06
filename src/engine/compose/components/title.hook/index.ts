// Definition of title.hook for the component library (Bible 9.2, used by hooks).

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/title.hook/component.html");

export const titleHook: ComponentDefinition = {
  name: "title.hook",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["text", "entrance", "entranceMs", "band", "durationMs"],
  fixtures,
};
