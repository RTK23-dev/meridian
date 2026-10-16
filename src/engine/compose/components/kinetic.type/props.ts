// Props for kinetic.type (Bible 9.2, beyond kinetic.punchline): one line of script text on screen at a time. Words arrive in
// sequence (stagger) or the whole line pops in (pop). Emphasis words take the kit's accent colour and a punch. Each line is
// data from the script, drawn with textContent, so markup in a line shows as text (L8 and Bible 9.1). A line stays on screen
// until the next line starts, or until the clip ends.

import { z } from "zod";
import { bandSchema, emphasisListSchema, shortTextSchema, withDuration } from "../shared.ts";

export const KINETIC_ENTRANCES = ["stagger", "pop"] as const;

/** At most this many words in all, so the lines stay readable at the component's size (Bible 8.3 caption length). */
export const MAX_KINETIC_WORDS = 24;

export const kineticLineSchema = z.object({
  text: shortTextSchema(40),
  atMs: z.int().nonnegative().max(3_600_000),
});
export type KineticLine = z.infer<typeof kineticLineSchema>;

export const propsSchema = withDuration({
  lines: z.array(kineticLineSchema).min(1).max(6),
  emphasis: emphasisListSchema.default([]),
  entrance: z.enum(KINETIC_ENTRANCES).default("stagger"),
  wordStepMs: z.int().min(40).max(300).default(120),
  band: bandSchema.default("middle"),
})
  .refine((props) => props.lines.every((line) => line.atMs < props.durationMs), {
    message: "every line must start inside the clip",
    path: ["lines"],
  })
  .refine((props) => props.lines.every((line, index) => index === 0 || line.atMs > props.lines[index - 1].atMs), {
    message: "lines must start in strictly increasing time order",
    path: ["lines"],
  })
  .refine(
    (props) => props.lines.reduce((count, line) => count + line.text.trim().split(/\s+/).length, 0) <= MAX_KINETIC_WORDS,
    { message: `a kinetic type shot holds at most ${MAX_KINETIC_WORDS} words`, path: ["lines"] },
  );

export type KineticTypeProps = z.infer<typeof propsSchema>;
