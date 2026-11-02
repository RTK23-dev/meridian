// Props for panel.bars (round 3, K21): a data panel with up to eight labelled bars, in the room style. The bars grow on the composition clock,
// in proportion to the largest value. Labels and values are set with textContent, never as markup.

import { z } from "zod";
import { shortTextSchema, withDuration } from "../shared.ts";

export const barSchema = z.object({
  label: shortTextSchema(20),
  value: z.number().finite().min(0).max(1_000_000_000),
});

export const propsSchema = withDuration({
  title: shortTextSchema(60),
  bars: z.array(barSchema).min(1).max(8),
});

export type PanelBarsProps = z.infer<typeof propsSchema>;
