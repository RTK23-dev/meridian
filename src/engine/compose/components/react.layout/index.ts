// Definition of react.layout for the component library (Bible 9.2, used by react_clip shots).

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const reactLayout: ComponentDefinition = {
  name: "react.layout",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
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
