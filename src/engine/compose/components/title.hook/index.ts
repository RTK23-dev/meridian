// Definition of title.hook for the component library (Bible 9.2, used by hooks).

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const titleHook: ComponentDefinition = {
  name: "title.hook",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["text", "entrance", "entranceMs", "band", "durationMs"],
  fixtures,
};
