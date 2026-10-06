import { z } from "zod";
import { WEIGHT_KEYS, type ScoreWeights } from "../scoring.ts";

const workspaceName = z.string().trim().min(1, "Workspace name is required.").max(80, "Workspace name must be 80 characters or fewer.");

export const workspaceNameSchema = z.object({ name: workspaceName });

export const memberInviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(200, "Email must be 200 characters or fewer.")),
  role: z.enum(["admin", "member", "viewer"]),
});

const weightInput = z.string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "Enter a number from 0 to 5.")
  .transform(Number)
  .pipe(z.number().min(0, "Value must be from 0 to 5.").max(5, "Value must be from 0 to 5."));

const weightFields = Object.fromEntries(WEIGHT_KEYS.map((key) => [key, weightInput])) as Record<keyof ScoreWeights, typeof weightInput>;
export const scoringWeightsSchema = z.object(weightFields) satisfies z.ZodType<ScoreWeights>;

export type WorkspaceNameInput = z.input<typeof workspaceNameSchema>;
export type MemberInviteInput = z.input<typeof memberInviteSchema>;
export type ScoringWeightsInput = z.input<typeof scoringWeightsSchema>;
