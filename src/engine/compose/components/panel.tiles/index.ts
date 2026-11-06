// Definition of panel.tiles for the component library (round 3, K21): a data panel with one to six tiles, each a short value and its label, in the room style.

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/panel.tiles/component.html");

export const panelTiles: ComponentDefinition = {
  name: "panel.tiles",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["title", "durationMs"],
  fixtures,
};
