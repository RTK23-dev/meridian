// Budget reservation and ledger entry (Bible sections 4.4 and 14).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { sumUsd, usdSchema } from "./money.ts";

export const BUDGET_MODES = ["observe", "warn", "cap"] as const;
export const budgetModeSchema = z.enum(BUDGET_MODES);
export type BudgetMode = z.infer<typeof budgetModeSchema>;

export const RESERVATION_STATES = ["reserved", "paused", "released"] as const;
export const reservationStateSchema = z.enum(RESERVATION_STATES);
export type ReservationState = z.infer<typeof reservationStateSchema>;

export const budgetLineSchema = z.object({
  stage: z.string().min(1),
  shotId: idSchema("shot_").optional(),
  provider: z.string().min(1).optional(),
  estimateUsd: usdSchema,
});
export type BudgetLine = z.infer<typeof budgetLineSchema>;

/**
 * v1 invariants: estimateUsd is the sum of the lines; a paused reservation names its reason;
 * reservedUsd is what the reservation holds (for a paused one, what it would hold once resumed;
 * for a released one, the amount actually committed).
 */
export const budgetReservationSchema = z
  .object({
    schema: z.literal("meridian.budget_reservation/v1"),
    reservationId: idSchema("res_"),
    requestId: idSchema("req_"),
    workspaceId: z.string().min(1),
    mode: budgetModeSchema,
    lines: z.array(budgetLineSchema),
    estimateUsd: usdSchema,
    redoAllowanceUsd: usdSchema,
    reservedUsd: usdSchema,
    state: reservationStateSchema,
    pausedReason: z.string().min(1).optional(),
    createdAt: z.iso.datetime(),
  })
  .refine((reservation) => reservation.state !== "paused" || reservation.pausedReason !== undefined, {
    message: "a paused reservation needs pausedReason",
  })
  .refine((reservation) => reservation.estimateUsd === sumUsd(reservation.lines.map((line) => line.estimateUsd)), {
    message: "estimateUsd must equal the sum of the lines",
  });
export type BudgetReservation = z.infer<typeof budgetReservationSchema>;

/**
 * The Claude roles of Bible 11.1. A Claude call's ledger entry names its role, so cost is traceable per role. A new role is
 * a contract change (a version bump and a Bible section 4 note).
 * `frame_reader` (contract v4) is the Haiku vision role that reads captions, shake and speed ramps from sampled frames, as
 * measurements only. It returns no visible text (Bible 1, copy genes never content).
 */
export const CLAUDE_ROLES = [
  "segmenter",
  "genome",
  "request_classifier",
  "planner",
  "director_check",
  "tightener",
  "critic_take",
  "critic_final",
  "prompt_fixer",
  "variant_writer",
  "frame_reader",
] as const;
export const claudeRoleSchema = z.enum(CLAUDE_ROLES);
export type ClaudeRole = z.infer<typeof claudeRoleSchema>;

/** A prompt version in the form `<role>@<n>` (for example "planner@1"), as in Manifest.promptVersions. */
export const promptVersionSchema = z.string().regex(/^[a-z][a-z0-9_]*@[1-9][0-9]*$/, {
  message: "a prompt version is <role>@<n>, for example planner@1",
});
export type PromptVersion = z.infer<typeof promptVersionSchema>;

/**
 * One paid call. Written before the call is submitted. An entry without actualUsd is still held.
 * actualIsEstimate is set when the actual is a list-price fallback, not the provider's bill (Bible 14.1 step 4).
 * role and promptVersion (contract v2) trace a Claude call to its role and prompt version. They are set together, and the
 * prompt version must be a version of that role. Entries written before v2 have neither and stay valid.
 */
export const ledgerEntrySchema = z
  .object({
    entryId: idSchema("led_"),
    requestId: idSchema("req_"),
    stage: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    estimateUsd: usdSchema,
    reservedUsd: usdSchema,
    actualUsd: usdSchema.optional(),
    actualIsEstimate: z.boolean().optional(),
    idempotencyKey: z.string().min(1),
    at: z.iso.datetime(),
    role: claudeRoleSchema.optional(),
    promptVersion: promptVersionSchema.optional(),
  })
  .refine((entry) => entry.actualIsEstimate === undefined || entry.actualUsd !== undefined, {
    message: "actualIsEstimate needs actualUsd",
  })
  .refine((entry) => (entry.role === undefined) === (entry.promptVersion === undefined), {
    message: "role and promptVersion are set together",
  })
  .refine(
    (entry) => entry.role === undefined || entry.promptVersion === undefined || entry.promptVersion.startsWith(`${entry.role}@`),
    { message: "promptVersion must be a version of role" },
  );
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
