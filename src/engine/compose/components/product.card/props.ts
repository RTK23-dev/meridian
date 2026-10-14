// Props for product.card (Bible 9.2): the Bible's product downgrade target and the card for product beats (L8).
// heroUri is a media URI. The compiler maps every `*Uri` prop to a local asset path before the component sees it.
// Name, bullets and price are drawn as text by code; the component never invents product imagery or prices.

import { z } from "zod";
import { shortTextSchema, withDuration } from "../shared.ts";

export const propsSchema = withDuration({
  name: shortTextSchema(60),
  bullets: z.array(shortTextSchema(60)).max(3).default([]),
  price: shortTextSchema(16).optional(),
  heroUri: z.string().min(1).max(2000).optional(),
});

export type ProductCardProps = z.infer<typeof propsSchema>;
