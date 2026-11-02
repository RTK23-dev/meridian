// Props for stat.counter (round 3, K21): a number that counts up over the clip, with a pill label under it. Used for the count in a hook or a
// proof ("414 cars counted"). The number is drawn by code; the text is set with textContent, never as markup.

import { z } from "zod";
import { shortTextSchema, withDuration } from "../shared.ts";

export const propsSchema = withDuration({
  value: z.number().finite().min(0).max(1_000_000_000),
  label: shortTextSchema(40),
  decimals: z.int().min(0).max(2).default(0),
  prefix: shortTextSchema(4).optional(),
  suffix: shortTextSchema(4).optional(),
});

export type StatCounterProps = z.infer<typeof propsSchema>;
