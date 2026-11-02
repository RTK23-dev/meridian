import { z } from "zod";

/** The shortest reason that can accept a direction. The server enforces the same length. */
export const DIRECTION_REASON_MIN = 20;

/** The reason that accepts a direction or asks for the next brief. Trimmed, and at least the server's length. */
export const directionReasonSchema = z.object({
  reason: z.string().trim().min(DIRECTION_REASON_MIN, `Write at least ${DIRECTION_REASON_MIN} characters.`),
});

export type DirectionReasonInput = z.input<typeof directionReasonSchema>;
