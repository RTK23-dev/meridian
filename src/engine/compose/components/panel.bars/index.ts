// Definition of panel.bars for the component library (round 3, K21): a data panel with up to eight labelled bars, in the room style.

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/panel.bars/component.html");

export const panelBars: ComponentDefinition = {
  name: "panel.bars",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["title", "durationMs"],
  fixtures,
};
