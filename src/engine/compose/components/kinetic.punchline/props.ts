// Props for kinetic.punchline (Bible 9.2): short lines that punch in on a rhythm, used by kinetic_type shots.

import { z } from "zod";
import { shortTextSchema, withDuration } from "../shared.ts";

export const propsSchema = withDuration({
  lines: z.array(shortTextSchema(60)).min(1).max(6),
  rhythmMs: z.int().min(200).max(2000).default(700),
  scale: z.number().min(0.8).max(1.4).default(1),
});

export type KineticPunchlineProps = z.infer<typeof propsSchema>;
