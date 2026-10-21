// Budget reservation and ledger entry (Bible sections 4.4 and 14).

import { z } from "zod";
import { idSchema } from "./ids.ts";
import { sumUsd, usdSchema } from "./money.ts";

export const BUDGET_MODES = ["observe", "warn", "cap"] as const;
export const budgetModeSchema = z.enum(BUDGET_MODES);
export type BudgetMode = z.infer<typeof budgetModeSchema>;

/**
 * reserved: calls may be authorized. paused: no call was authorized, because a cap refused the reservation at creation or an operator
 * paused it. exceeded (contract v6): a verified bill took the reservation above the amount it was authorized for, so no further paid
 * call is authorized and the bill counts toward the month. released: the reservation is closed at what is committed.
 */
export const RESERVATION_STATES = ["reserved", "paused", "exceeded", "released"] as const;
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
 * v1 invariants: estimateUsd is the sum of the lines; a paused or exceeded reservation names its reason;
 * reservedUsd is what the reservation holds (for a paused one, what it would hold once resumed;
 * for a released one, the amount actually committed).
 * Contract v6 adds the budgets the reservation was authorized against: the request's budget and the workspace month's budget.
 * A reservation written before v6 has neither, and is checked against its own reservedUsd only.
 */
/** The name the reservation's schema field carries (contract v1). */
export const BUDGET_RESERVATION_SCHEMA = "meridian.budget_reservation/v1" as const;

export const budgetReservationSchema = z
  .object({
    schema: z.literal(BUDGET_RESERVATION_SCHEMA),
    reservationId: idSchema("res_"),
    requestId: idSchema("req_"),
    workspaceId: z.string().min(1),
    mode: budgetModeSchema,
    lines: z.array(budgetLineSchema),
    estimateUsd: usdSchema,
    redoAllowanceUsd: usdSchema,
    reservedUsd: usdSchema,
    requestBudgetUsd: usdSchema.optional(),
    workspaceMonthBudgetUsd: usdSchema.optional(),
    state: reservationStateSchema,
    pausedReason: z.string().min(1).optional(),
    createdAt: z.iso.datetime(),
  })
  .refine((reservation) => (reservation.state !== "paused" && reservation.state !== "exceeded") || reservation.pausedReason !== undefined, {
    message: "a paused or exceeded reservation needs pausedReason",
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
 * `model_chooser` (contract v8) picks each production call's model from the OpenRouter catalog (Bible 10.5). It runs on llm.check.
 * `scriptwriter` (contract v8) writes a request's script from its brief and the analysed reference (Bible 6.x write_script). It runs
 * on llm.direction.
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
  "model_chooser",
  "scriptwriter",
  "orchestrator_plan",
] as const;
export const claudeRoleSchema = z.enum(CLAUDE_ROLES);
export type ClaudeRole = z.infer<typeof claudeRoleSchema>;

/** A prompt version in the form `<role>@<n>` (for example "planner@1"), as in Manifest.promptVersions. */
export const promptVersionSchema = z.string().regex(/^[a-z][a-z0-9_]*@[1-9][0-9]*$/, {
  message: "a prompt version is <role>@<n>, for example planner@1",
});
export type PromptVersion = z.infer<typeof promptVersionSchema>;

/**
 * One paid call. Written before the call is submitted, with its estimate (the list price, Bible 14.1 step 2) and its hold (reservedUsd).
 *
 * The actual cost is only ever one of two things, and never an estimate (contract v6). `actualUsd` with settlement "billed" is the
 * provider's verified bill. `actualUsd` 0 with settlement "confirmed_absent" is a call the provider confirmed created no job. With no
 * settlement the actual is unknown: the entry stays held at reservedUsd until a bill or a confirmation settles it.
 *
 * role and promptVersion (contract v2) trace a Claude call to its role and prompt version. They are set together, and the
 * prompt version must be a version of that role. Entries written before v2 have neither and stay valid.
 *
 * providerRef (contract v9) is the provider's own id for a paid call: the Deepgram request id, or the OpenRouter generation id. It is
 * recorded as soon as the provider names the call, whether or not a bill has arrived, so a held call can be settled later from its bill
 * (budget/reconcile-holds.ts). Null when the provider named none, and for every entry written before v9.
 */
export const LEDGER_SETTLEMENTS = ["billed", "confirmed_absent"] as const;
export const ledgerSettlementSchema = z.enum(LEDGER_SETTLEMENTS);
export type LedgerSettlement = z.infer<typeof ledgerSettlementSchema>;

/** The provider's own id for one paid call (contract v9). Bounded, and never executed or followed: it is an id, not text. */
export const providerRefSchema = z.string().min(1).max(512);
export type ProviderRef = z.infer<typeof providerRefSchema>;

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
    settlement: ledgerSettlementSchema.optional(),
    idempotencyKey: z.string().min(1),
    at: z.iso.datetime(),
    role: claudeRoleSchema.optional(),
    promptVersion: promptVersionSchema.optional(),
    providerRef: providerRefSchema.nullable().default(null),
  })
  .refine((entry) => (entry.actualUsd === undefined) === (entry.settlement === undefined), {
    message: "an actual cost needs a settlement, and a settlement needs an actual cost",
  })
  .refine((entry) => (entry.role === undefined) === (entry.promptVersion === undefined), {
    message: "role and promptVersion are set together",
  })
  .refine(
    (entry) => entry.role === undefined || entry.promptVersion === undefined || entry.promptVersion.startsWith(`${entry.role}@`),
    { message: "promptVersion must be a version of role" },
  );
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
