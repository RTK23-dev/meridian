// Props for panel.tiles (round 3, K21): a data panel with one to six tiles, each a short value and its label, in the room style. The values
// are text the person gives (a figure, a price, a short word), so nothing is formatted or computed here. Text is set with textContent.

import { z } from "zod";
import { shortTextSchema, withDuration } from "../shared.ts";

export const tileSchema = z.object({
  label: shortTextSchema(24),
  value: shortTextSchema(12),
});

export const propsSchema = withDuration({
  title: shortTextSchema(60),
  tiles: z.array(tileSchema).min(1).max(6),
});

export type PanelTilesProps = z.infer<typeof propsSchema>;
