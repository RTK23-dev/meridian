// Props for react.layout (Bible 9.2, used by react_clip shots): a base clip with the presenter in a picture-in-picture
// box. Both clips are media URIs (image or video); the compiler maps them to local assets before the component sees
// them. The picture-in-picture box sits inside the safe zones (Bible 8.3): 6% from the left, 12% from the right, 10%
// from the top and 20% from the bottom.

import { z } from "zod";
import { mediaUriSchema, msSchema, withDuration } from "../shared.ts";

export const PIP_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

export const propsSchema = withDuration({
  baseUri: mediaUriSchema,
  presenterUri: mediaUriSchema,
  baseInMs: msSchema.default(0),
  presenterInMs: msSchema.default(0),
  pip: z.enum(PIP_POSITIONS).default("bottom-right"),
  pipWidthPct: z.int().min(24).max(40).default(34),
  pipInMs: msSchema.default(0),
}).refine((props) => props.pipInMs < props.durationMs, {
  message: "pipInMs must fall inside the clip",
  path: ["pipInMs"],
});

export type ReactLayoutProps = z.infer<typeof propsSchema>;
