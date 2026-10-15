// Definition of screen.mock for the component library (Bible 9.2, screen_mock shots): a phone or desktop UI mock with a
// notification, an app screen or a chat.

import { readFileSync } from "node:fs";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

export const screenMock: ComponentDefinition = {
  name: "screen.mock",
  template: readFileSync(new URL("./component.html", import.meta.url), "utf8"),
  propsSchema,
  declaredVariables: ["device", "screen", "title", "app", "body", "timeLabel", "atMs", "rowStepMs", "iconUri", "imageUri", "durationMs"],
  fixtures,
};
