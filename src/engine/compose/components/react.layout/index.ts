// Definition of react.layout for the component library (Bible 9.2, used by react_clip shots).

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/react.layout/component.html");

export const reactLayout: ComponentDefinition = {
  name: "react.layout",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: [
    "baseUri",
    "presenterUri",
    "baseInMs",
    "presenterInMs",
    "pip",
    "pipInMs",
    "pipWidthPct",
    "durationMs",
  ],
  fixtures,
};
