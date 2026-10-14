// Prop helpers shared by the component schemas. Times are integer milliseconds from the start of the clip.

import { z } from "zod";
import { RESERVED_PROP_DURATION } from "../library.ts";

export const msSchema = z.int().nonnegative().max(3_600_000);

/** The clip span. The compiler sets it from the EDL, so it is always present when a component renders. */
export const durationMsSchema = z.int().positive().max(60_000);

export const shortTextSchema = (max: number) => z.string().min(1).max(max);

export const bandSchema = z.enum(["upper", "middle", "lower"]);

export const emphasisListSchema = z.array(shortTextSchema(40)).max(4);

/** A schema for one component's props: its own fields plus the reserved durationMs. */
export function withDuration<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, [RESERVED_PROP_DURATION]: durationMsSchema });
}
