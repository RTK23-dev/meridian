// Input checks for the direction server functions (actions.ts). Plain code with no server imports. Each check keeps only the fields it
// names: the workspace is always read from the draft (service.ts), never from the request body.

import { z } from "zod";
import { NICHE_FAMILIES, VIDEO_JOBS } from "./lists.ts";

const id = z.string().trim().regex(/^[A-Za-z0-9_:-]{1,100}$/, { message: "Choose a valid draft or script." });

export const draftInputSchema = z.object({ sessionId: id });
export type DraftInput = z.infer<typeof draftInputSchema>;

export const writeInputSchema = z.object({
  sessionId: id,
  count: z.int().min(1).max(4),
  job: z.enum(VIDEO_JOBS),
  niche: z.enum(NICHE_FAMILIES).nullable(),
  maxSeconds: z.int().min(5).max(180),
  language: z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, { message: "Set the script's language as a tag, for example en or pt-BR." }),
});
export type WriteInput = z.infer<typeof writeInputSchema>;

export const reviseInputSchema = z.object({ sessionId: id, scriptId: id, note: z.string().max(600, { message: "Keep a note to 600 characters." }).default("") });
export type ReviseInput = z.infer<typeof reviseInputSchema>;

export const chooseInputSchema = z.object({ sessionId: id, scriptId: id });
export type ChooseInput = z.infer<typeof chooseInputSchema>;

/** Parses one input, and turns a refusal into one plain sentence. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Error(issue?.message && !issue.message.startsWith("Invalid") && !issue.message.startsWith("Too") ? issue.message : `Check ${issue?.path.join(".") || "the input"}.`);
}
