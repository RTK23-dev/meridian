// Artifact envelope (lead decision, 2026-10-13): artifact metadata once, around any typed body.
// The body keeps its own schema literal; the envelope's schema must match it.

import { z } from "zod";
import { contentHashSchema } from "./hash.ts";
import { idSchema } from "./ids.ts";

export const ARTIFACT_TYPES = [
  "production_request",
  "validated_request",
  "video_dna",
  "voice_track",
  "scene_plan",
  "budget_reservation",
  "asset_spec",
  "take",
  "take_verdict",
  "edl",
  "composition",
  "rendered_video",
  "gate_result",
  "review_result",
  "manifest",
] as const;

export const artifactTypeSchema = z.enum(ARTIFACT_TYPES);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

export type ArtifactEnvelope<Body> = {
  artifactId: string;
  type: ArtifactType;
  schema: string;
  workspaceId: string;
  requestId: string;
  parentIds: string[];
  contentHash: string;
  createdAt: string;
  body: Body;
};

/** Envelope around a body schema. A body with a schema literal must agree with the envelope's schema. */
export function envelopeSchema<Body extends z.ZodType>(bodySchema: Body) {
  return z
    .object({
      artifactId: idSchema("art_"),
      type: artifactTypeSchema,
      schema: z.string().regex(/^meridian\.[a-z_]+\/v[0-9]+$/),
      workspaceId: z.string().min(1),
      requestId: idSchema("req_"),
      parentIds: z.array(z.string().min(1)),
      contentHash: contentHashSchema,
      createdAt: z.iso.datetime(),
      body: bodySchema,
    })
    .refine(
      (envelope) => {
        const body: unknown = (envelope as { body?: unknown }).body;
        const bodyLiteral: unknown = typeof body === "object" && body !== null ? (body as { schema?: unknown }).schema : undefined;
        return bodyLiteral === undefined || bodyLiteral === envelope.schema;
      },
      { message: "envelope.schema must match body.schema" },
    );
}
