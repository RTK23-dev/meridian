// Definition of captions.karaoke for the component library (Bible 9.2, used by all videos).

import { sourceFile } from "../../../source-file.ts";
import type { ComponentDefinition } from "../../library.ts";
import { fixtures } from "./fixtures/index.ts";
import { propsSchema } from "./props.ts";

/** The template, read on first use (never at module load: it is not beside the module in the production bundle). */
const template = sourceFile(import.meta.url, "./component.html", "src/engine/compose/components/captions.karaoke/component.html");

export const captionsKaraoke: ComponentDefinition = {
  name: "captions.karaoke",
  get template() {
    return template();
  },
  propsSchema,
  declaredVariables: ["band", "durationMs"],
  fixtures,
};
