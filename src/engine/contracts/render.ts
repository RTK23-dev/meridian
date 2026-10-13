// Composition (the compiled HyperFrames directory) and the rendered MP4 (Bible sections 4.4, 6.9, 6.11, 9.1).

import { z } from "zod";
import { contentHash, contentHashSchema } from "./hash.ts";
import { idSchema } from "./ids.ts";
import { usdSchema } from "./money.ts";
import { positiveMsSchema } from "./primitives.ts";

export const compositionFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
      message: "composition paths are relative and cannot contain ..",
    }),
  contentHash: contentHashSchema,
  bytes: z.int().nonnegative(),
});
export type CompositionFile = z.infer<typeof compositionFileSchema>;

/** The composition hash: sha256 of the canonical JSON of its file list. It is the render idempotency key. */
export function compositionHash(files: readonly CompositionFile[]): string {
  return contentHash(files);
}

export const compositionSchema = z
  .object({
    schema: z.literal("meridian.composition/v1"),
    compositionId: idSchema("cmp_"),
    edlId: idSchema("edl_"),
    rootFile: z.literal("index.html"),
    files: z.array(compositionFileSchema).min(1),
    assetUris: z.array(z.string().min(1)),
    contentHash: contentHashSchema,
  })
  .refine((composition) => composition.files.some((file) => file.path === composition.rootFile), {
    message: "rootFile must be one of the composition files",
  })
  .refine((composition) => new Set(composition.files.map((file) => file.path)).size === composition.files.length, {
    message: "composition file paths must be unique",
  })
  .refine((composition) => composition.contentHash === compositionHash(composition.files), {
    message: "contentHash must be the hash of the composition files",
  });
export type Composition = z.infer<typeof compositionSchema>;

export const renderedVideoSchema = z.object({
  videoId: idSchema("vid_"),
  edlId: idSchema("edl_"),
  uri: z.string().min(1),
  renderer: z.string().min(1),
  durationMs: positiveMsSchema,
  bytes: z.int().positive(),
  costUsd: usdSchema,
  idempotencyKey: contentHashSchema,
});
export type RenderedVideo = z.infer<typeof renderedVideoSchema>;
