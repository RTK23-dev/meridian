// Props for title.hook (Bible 9.2): the hook line shown in the first second. The hook caption must be on screen by
// 500 ms (Bible 8.2 step 5), so the entrance is capped at 500 ms.

import { z } from "zod";
import { bandSchema, emphasisListSchema, shortTextSchema, withDuration } from "../shared.ts";

export const ENTRANCES = ["pop", "slide", "fade"] as const;

export const propsSchema = withDuration({
  text: shortTextSchema(80),
  emphasis: emphasisListSchema.default([]),
  entrance: z.enum(ENTRANCES).default("pop"),
  entranceMs: z.int().min(100).max(500).default(250),
  band: bandSchema.default("middle"),
});

export type TitleHookProps = z.infer<typeof propsSchema>;
