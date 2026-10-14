// Definition of captions.karaoke for the component library (Bible 9.2, used by all videos).

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const captionsKaraoke: ComponentDefinition = {
  name: "captions.karaoke",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["band", "durationMs"],
  fixtures,
};
