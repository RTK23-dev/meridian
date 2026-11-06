// Definition of screen.mock for the component library (Bible 9.2, screen_mock shots): a phone or desktop UI mock with a
// notification, an app screen or a chat.

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/screen.mock/component.html");

export const screenMock: ComponentDefinition = {
  name: "screen.mock",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["device", "screen", "title", "app", "body", "timeLabel", "atMs", "rowStepMs", "iconUri", "imageUri", "durationMs"],
  fixtures,
};
