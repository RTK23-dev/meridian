// Props for compare.split (Bible 9.2, comparisons): two panels side by side, each with a label. Each panel takes an
// optional media URI (image or video); without one, the panel is a plain kit colour. The right panel wipes in at
// revealMs. Labels are short (12 characters at most) so each sits inside its half of the frame and the right 12% stays
// clear (Bible 8.3).

import { mediaUriSchema, msSchema, shortTextSchema, withDuration } from "../shared.ts";

export const propsSchema = withDuration({
  leftLabel: shortTextSchema(12),
  rightLabel: shortTextSchema(12),
  leftUri: mediaUriSchema.optional(),
  rightUri: mediaUriSchema.optional(),
  revealMs: msSchema.default(0),
}).refine((props) => props.revealMs < props.durationMs, {
  message: "revealMs must fall inside the clip",
  path: ["revealMs"],
});
