// Definition of chat.thread for the component library (Bible 9.2, screen_mock DM stories).

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const chatThread: ComponentDefinition = {
  name: "chat.thread",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["header", "durationMs"],
  fixtures,
};
