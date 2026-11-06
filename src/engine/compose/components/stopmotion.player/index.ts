// Definition of stopmotion.player for the component library (Bible 7.1 `stop_motion`, 9.2). sourceBound: its frames must
// be the shot's own takes, passed to compile() per clip.

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/stopmotion.player/component.html");

export const stopmotionPlayer: ComponentDefinition = {
  name: "stopmotion.player",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["fps", "durationMs"],
  fixtures,
  sourceBound: true,
};
