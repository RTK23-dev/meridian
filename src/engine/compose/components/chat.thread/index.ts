// Definition of chat.thread for the component library (Bible 9.2, screen_mock DM stories).

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/chat.thread/component.html");

export const chatThread: ComponentDefinition = {
  name: "chat.thread",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["header", "durationMs"],
  fixtures,
};
