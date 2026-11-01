// Props for label.pill (round 3, K21): the place and the date of a clip, in a pill at the top of the frame. The date is optional. The text is
// set with textContent, never as markup.

import { z } from "zod";
import { shortTextSchema, withDuration } from "../shared.ts";

export const propsSchema = withDuration({
  place: shortTextSchema(40),
  date: shortTextSchema(24).optional(),
});

export type LabelPillProps = z.infer<typeof propsSchema>;
