// Props for cta.card (Bible 9.2): the ending call to action. The DM keyword is drawn as text by code (L8).

import { z } from "zod";
import { shortTextSchema, withDuration } from "../shared.ts";

export const ARROWS = ["down", "up", "right", "none"] as const;

export const propsSchema = withDuration({
  text: shortTextSchema(80),
  keyword: shortTextSchema(20).optional(),
  arrow: z.enum(ARROWS).default("down"),
});

export type CtaCardProps = z.infer<typeof propsSchema>;
