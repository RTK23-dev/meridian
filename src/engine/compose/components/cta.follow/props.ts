// Props for cta.follow (round 3, K21): a follow prompt, a pill with a prompt and a handle, in the lower band above the bottom 20% line. Distinct
// from cta.card, which is the closing card. Text is set with textContent, never as markup.

import { z } from "zod";
import { shortTextSchema, withDuration } from "../shared.ts";

export const propsSchema = withDuration({
  handle: shortTextSchema(40),
  prompt: shortTextSchema(40).optional(),
});

export type CtaFollowProps = z.infer<typeof propsSchema>;
