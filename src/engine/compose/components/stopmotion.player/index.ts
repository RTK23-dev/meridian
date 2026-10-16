// Definition of stopmotion.player for the component library (Bible 7.1 `stop_motion`, 9.2). sourceBound: its frames must
// be the shot's own takes, passed to compile() per clip.

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const stopmotionPlayer: ComponentDefinition = {
  name: "stopmotion.player",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["fps", "durationMs"],
  fixtures,
  sourceBound: true,
};
