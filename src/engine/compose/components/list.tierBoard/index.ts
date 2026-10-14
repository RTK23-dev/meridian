// Definition of list.tierBoard for the component library (Bible 9.2, tier-list formats).

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const listTierBoard: ComponentDefinition = {
  name: "list.tierBoard",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["title", "durationMs"],
  fixtures,
};
