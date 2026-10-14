// Props for captions.karaoke (Bible 9.2). Word times are ms from the start of the clip. The editor groups words into
// captions (Bible 8.2 step 9); the component only draws them and moves the highlight with the composition clock.

import { z } from "zod";
import { spanOk, SPAN_MESSAGE } from "../../../contracts/index.ts";
import { bandSchema, msSchema, shortTextSchema, withDuration } from "../shared.ts";

export const karaokeWordSchema = z
  .object({ text: shortTextSchema(40), startMs: msSchema, endMs: msSchema })
  .refine(spanOk, { message: SPAN_MESSAGE });

export const karaokeCaptionSchema = z
  .object({
    startMs: msSchema,
    endMs: msSchema,
    words: z.array(karaokeWordSchema).min(1).max(8),
  })
  .refine(spanOk, { message: SPAN_MESSAGE })
  .refine((caption) => caption.words.every((word) => word.startMs >= caption.startMs && word.endMs <= caption.endMs), {
    message: "every word must sit inside its caption",
  })
  .refine(
    (caption) => caption.words.every((word, index) => index === 0 || word.startMs >= caption.words[index - 1].endMs),
    { message: "words must not overlap" },
  );

export const propsSchema = withDuration({
  captions: z.array(karaokeCaptionSchema).max(60).default([]),
  band: bandSchema.default("lower"),
});

export type CaptionsKaraokeProps = z.infer<typeof propsSchema>;
