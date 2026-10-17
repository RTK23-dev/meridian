// One request's orchestrator model choices (contract v8, Bible 10.5). The artifact is the record of every model the orchestrator chose
// for the request's paid calls. Each choice is the v7 `modelChoice` of the call's asset spec, keyed by the call's shot and output.
// A request has one such artifact. Its key is the request id: the store writes at most one per request, and a second write for the
// same request is refused by the store, not by this schema.

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { modelChoiceSchema } from "./assets.ts";
import { chainOutputNameSchema, modelClassSchema } from "./plan.ts";

/**
 * One choice: the call of a shot that it was made for. `output` is the chain call's output name (the key the asset spec is built
 * for). `modelChoice` is never null: a call with no choice has no entry, so a null here is refused.
 */
export const modelChoiceEntrySchema = z.object({
  shotId: idSchema("shot_"),
  output: chainOutputNameSchema,
  modelClass: modelClassSchema,
  modelChoice: modelChoiceSchema,
});
export type ModelChoiceEntry = z.infer<typeof modelChoiceEntrySchema>;

export const modelChoicesSchema = z
  .object({
    schema: z.literal("meridian.model_choices/v1"),
    requestId: idSchema("req_"),
    /** When the request's catalog was read. Each choice also carries the read time of its own catalog (video and image reads differ). */
    catalogReadAt: z.iso.datetime(),
    /** Empty when the request made no model choice. */
    choices: z.array(modelChoiceEntrySchema),
  })
  .superRefine((body, ctx) => {
    // (shotId, output) names one call: a pair that repeats is two choices for one call, and is refused.
    const seen = new Set<string>();
    body.choices.forEach((choice, index) => {
      const key = JSON.stringify([choice.shotId, choice.output]);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["choices", index],
          message: `shot ${choice.shotId} has more than one choice for output "${choice.output}"`,
        });
      }
      seen.add(key);
    });
  });
export type ModelChoices = z.infer<typeof modelChoicesSchema>;
