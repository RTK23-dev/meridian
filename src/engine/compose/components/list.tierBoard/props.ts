// Props for list.tierBoard (Bible 9.2, tier-list formats): tiers as rows, items dropped into a row at a set time.
// Item images are product or item imagery (L8), image URIs only; the compiler maps them to local assets. Names and tier
// labels are drawn as text by code. Each tier shows at most four items (one row of four cards), so the board fits.

import { z } from "zod";
import { imageUriSchema, msSchema, shortTextSchema, withDuration } from "../shared.ts";

export const TONES = ["accent", "primary", "secondary", "text"] as const;
export const ITEMS_PER_TIER = 4;

export const tierSchema = z.object({
  label: shortTextSchema(2),
  tone: z.enum(TONES).default("primary"),
});

export const boardItemSchema = z.object({
  name: shortTextSchema(24),
  tier: z.int().nonnegative(),
  dropMs: msSchema,
  imageUri: imageUriSchema.optional(),
});

export const propsSchema = withDuration({
  title: shortTextSchema(60).optional(),
  tiers: z.array(tierSchema).min(1).max(5),
  items: z.array(boardItemSchema).max(20).default([]),
})
  .refine((props) => props.items.every((item) => item.tier < props.tiers.length), {
    message: "every item's tier must be the index of one of the tiers",
    path: ["items"],
  })
  .refine(
    (props) =>
      props.tiers.every((_, index) => props.items.filter((item) => item.tier === index).length <= ITEMS_PER_TIER),
    { message: `a tier holds at most ${ITEMS_PER_TIER} items`, path: ["items"] },
  )
  .refine((props) => props.items.every((item) => item.dropMs < props.durationMs), {
    message: "every dropMs must fall inside the clip",
    path: ["items"],
  });

export type TierBoardProps = z.infer<typeof propsSchema>;
