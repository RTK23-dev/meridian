import { z } from "zod";

export const studioGenerationSchema = z.object({
  imageProvider: z.enum(["none", "test:image", "google:nano-banana"]),
  videoProvider: z.enum(["hypit", "none"]),
});

export type StudioGeneration = z.infer<typeof studioGenerationSchema>;
