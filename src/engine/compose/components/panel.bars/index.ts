// Definition of panel.bars for the component library (round 3, K21): a data panel with up to eight labelled bars, in the room style.

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const panelBars: ComponentDefinition = {
  name: "panel.bars",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["title", "durationMs"],
  fixtures,
};
