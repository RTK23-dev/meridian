// Voice track: our narration with word timings (Bible section 4.2 and 6.3).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { wordSchema } from "./analysis.ts";
import { msSchema, positiveMsSchema, SPAN_MESSAGE, spanOk } from "./primitives.ts";

export const beatSpanSchema = z
  .object({
    beatId: z.string().min(1),
    startMs: msSchema,
    endMs: msSchema,
  })
  .refine(spanOk, { message: SPAN_MESSAGE });
export type BeatSpan = z.infer<typeof beatSpanSchema>;

export const voiceTrackSchema = z.object({
  schema: z.literal("meridian.voice_track/v1"),
  voiceTrackId: z.string().min(1),
  requestId: idSchema("req_"),
  voiceId: z.string().min(1),
  provider: z.string().min(1),
  audioUri: z.string().min(1),
  durationMs: positiveMsSchema,
  lufs: z.number().finite(),
  words: z.array(wordSchema),
  beatSpans: z.array(beatSpanSchema),
});
export type VoiceTrack = z.infer<typeof voiceTrackSchema>;
