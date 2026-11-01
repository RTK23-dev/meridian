// Props for captions.boxed (round 3, K21): the captions and bands of captions.karaoke, with the spoken word in a filled box. The caption
// and word rules are the karaoke ones, so the two components take the same data. Word times are ms from the start of the clip.

import { z } from "zod";
import { bandSchema, withDuration } from "../shared.ts";
import { karaokeCaptionSchema } from "../captions.karaoke/props.ts";

export const propsSchema = withDuration({
  captions: z.array(karaokeCaptionSchema).max(60).default([]),
  band: bandSchema.default("lower"),
});

export type CaptionsBoxedProps = z.infer<typeof propsSchema>;
