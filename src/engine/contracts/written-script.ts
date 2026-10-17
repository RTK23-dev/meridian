// The script the engine writes from a brief (contract v8, Bible 6.x write_script). It is an artifact: the words, beat by beat, the
// writer's rationale, and what the script is based on. Its beats have the same shape as a request's script beats.

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { scriptBeatSchema } from "./request.ts";
import { nonBlankText } from "./primitives.ts";

/** The longest rationale a written script carries, in characters (contract v8). */
export const WRITTEN_SCRIPT_RATIONALE_MAX = 2000;

export const writtenScriptSchema = z
  .object({
    schema: z.literal("meridian.written_script/v1"),
    requestId: idSchema("req_"),
    language: z.string().min(1),
    beats: z.array(scriptBeatSchema).min(1),
    rationale: nonBlankText(WRITTEN_SCRIPT_RATIONALE_MAX),
    /** What the script was written from: the analysed reference (its DNA) and the labels of the brief's sources it used. */
    basedOn: z.object({
      videoDnaId: idSchema("dna_"),
      sourceLabels: z.array(z.string().min(1)),
    }),
  })
  .refine((script) => new Set(script.beats.map((beat) => beat.beatId)).size === script.beats.length, {
    message: "each beat of a written script has its own beatId",
    path: ["beats"],
  });
export type WrittenScript = z.infer<typeof writtenScriptSchema>;
