// Props for panel.line (round 3, K21): a data panel with a line through two to twelve labelled points, in the room style. The line draws on the
// composition clock, scaled to the largest value. Labels and the title are set with textContent, never as markup.

import { z } from "zod";
import { shortTextSchema, withDuration } from "../shared.ts";

export const pointSchema = z.object({
  label: shortTextSchema(20),
  value: z.number().finite().min(0).max(1_000_000_000),
});

export const propsSchema = withDuration({
  title: shortTextSchema(60),
  points: z.array(pointSchema).min(2).max(12),
});

export type PanelLineProps = z.infer<typeof propsSchema>;
