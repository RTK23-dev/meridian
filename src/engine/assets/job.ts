// The asynchronous job reference of one asset submit (Bible 10.1, 10.4, 15.2) and the settlement store that makes settling it
// idempotent. A submit returns an AssetJob: the provider's job id, the submit's ledger key, the candidate targets in their scored
// order, and the attempt state (which target, which attempt, what has been billed so far). The poller hands it back to settle
// with the provider's answer. The job is plain JSON: it is validated here on every parse, because it crosses a job payload
// (untrusted input, Bible 1).

import { z } from "zod";
import { EngineError } from "../contracts/errors.ts";
import { idSchema } from "../contracts/ids.ts";
import { modelClassSchema } from "../contracts/plan.ts";
import { usdSchema } from "../contracts/money.ts";

export const ASSET_JOB_SCHEMA = "meridian.asset_job/v1" as const;

/** The most reasons, targets or duplicates a job carries. Longer lists are cut, never grown (the job stays small). */
export const CARRY_LIMIT = 16;

const reasonText = z.string().min(1).max(400);

/** One routed target of the asset, in its scored order. The cache key is the target's own (it includes the provider). */
export const assetTargetSchema = z.object({
  adapterId: z.string().min(1).max(200),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  cacheKey: z.string().min(1).max(200),
  estimateUsd: usdSchema,
});
export type AssetTarget = z.infer<typeof assetTargetSchema>;

/** What the router has learned so far about the targets it has not used yet, for the final reason of an asset. */
export const assetJobCarrySchema = z.object({
  excluded: z.array(reasonText).max(CARRY_LIMIT),
  exhausted: z.array(reasonText).max(CARRY_LIMIT),
  refused: z.array(reasonText).max(CARRY_LIMIT),
  queued: z.array(reasonText).max(CARRY_LIMIT),
  duplicate: z.object({ providerId: z.string().min(1).max(200), ledgerEntryId: z.string().min(1).max(200) }).nullable(),
});
export type AssetJobCarry = z.infer<typeof assetJobCarrySchema>;

export const assetJobSchema = z
  .object({
    schema: z.literal(ASSET_JOB_SCHEMA),
    /** The provider's job id. The poller polls this. */
    jobRef: z.string().min(1).max(512),
    workspaceId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    reservationId: idSchema("res_"),
    stage: z.string().min(1).max(64),
    modelClass: modelClassSchema,
    /** The adapter id of this submit's target: "<provider>:<model>". */
    providerId: z.string().min(1).max(200),
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(200),
    /** The ledger key of this submit (and the idempotency key sent with it). Its settlement is recorded under it. */
    idempotencyKey: z.string().min(1).max(200),
    /** 1 for the first submit on the target, then 2, 3 for its retries (Bible 10.4). */
    attemptOnTarget: z.int().positive(),
    /** The submit's number across the whole asset, from 1. */
    submitNumber: z.int().positive(),
    /** ISO time of the submit. The poll deadline is measured from it. */
    submittedAt: z.iso.datetime(),
    targets: z.array(assetTargetSchema).min(1).max(CARRY_LIMIT),
    targetIndex: z.int().nonnegative(),
    /** The reconciled bills of this target's earlier submits (and of this one, once settled). */
    targetBilledUsd: usdSchema,
    /** True while every submit on this target has a provider bill. A list estimate makes it false. */
    targetAllBilled: z.boolean(),
    /** Submits made on this target, this one included. */
    targetSubmits: z.int().positive(),
    /** The ledger entry of the target's first submit, which the asset names as its ledger entry. */
    targetFirstEntryId: z.string().min(1).max(200).nullable(),
    carry: assetJobCarrySchema,
  })
  .refine((job) => job.targets[job.targetIndex]?.adapterId === job.providerId, {
    message: "providerId must be the adapter id of the target at targetIndex",
    path: ["providerId"],
  })
  .refine((job) => job.targets[job.targetIndex]?.provider === job.provider && job.targets[job.targetIndex]?.model === job.model, {
    message: "provider and model must be those of the target at targetIndex",
    path: ["model"],
  });
export type AssetJob = z.infer<typeof assetJobSchema>;

/** Parses a job reference or throws an invalid_input error. Nothing is trusted until it has parsed. */
export function parseAssetJob(value: unknown): AssetJob {
  const parsed = assetJobSchema.safeParse(value);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `the asset job reference does not parse: ${parsed.error.issues[0]?.message ?? "unknown shape"}`, {
      stage: "produce_shot",
    });
  }
  return parsed.data;
}

/** A list cut to the carry limit. The first reasons are kept; a longer list is never grown past the schema. */
export function capped<T>(items: readonly T[]): T[] {
  return items.slice(0, CARRY_LIMIT);
}

export type SettlementClaim<T> = { status: "claimed" } | { status: "settled"; value: T } | { status: "in_progress" };

export type SettlementClaimInput = {
  /** Who is claiming. Each settle call names itself, so a second concurrent call is told the first is still running. */
  owner: string;
  nowMs: number;
  /** How long a claim holds before another settle may take it over (a worker that died mid-settle). */
  leaseMs: number;
};

/**
 * Records the settled result of each submit. A settle claims its submit first; a claim that is already settled returns its
 * recorded result, and a claim that is still held by another call says so. The first completed result wins, so a job settled
 * twice changes nothing (Bible 5.1: a retry repeats no paid call). Production uses the Postgres store; the memory store is for
 * tests and single-process use.
 */
export interface SettlementStore<T> {
  claim(key: string, input: SettlementClaimInput): Promise<SettlementClaim<T>>;
  complete(key: string, owner: string, value: T): Promise<void>;
  release(key: string, owner: string): Promise<void>;
}

type Slot<T> = { owner: string; claimedUntilMs: number; settled: { value: T } | null };

export function memorySettlementStore<T>(): SettlementStore<T> {
  const slots = new Map<string, Slot<T>>();
  return {
    async claim(key, input) {
      const slot = slots.get(key);
      if (slot?.settled) return { status: "settled", value: structuredClone(slot.settled.value) };
      if (slot && slot.claimedUntilMs > input.nowMs && slot.owner !== input.owner) return { status: "in_progress" };
      slots.set(key, { owner: input.owner, claimedUntilMs: input.nowMs + input.leaseMs, settled: null });
      return { status: "claimed" };
    },
    async complete(key, _owner, value) {
      const slot = slots.get(key);
      if (slot?.settled) return;
      slots.set(key, { owner: slot?.owner ?? "", claimedUntilMs: 0, settled: { value: structuredClone(value) } });
    },
    async release(key, owner) {
      const slot = slots.get(key);
      if (slot && !slot.settled && slot.owner === owner) slots.delete(key);
    },
  };
}
