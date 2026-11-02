// Definition of panel.tiles for the component library (round 3, K21): a data panel with one to six tiles, each a short value and its label, in the room style.

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const panelTiles: ComponentDefinition = {
  name: "panel.tiles",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["title", "durationMs"],
  fixtures,
};
