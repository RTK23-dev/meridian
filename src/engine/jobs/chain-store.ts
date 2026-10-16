// Chain call records (Video Engine Bible 7.1 chains, contract v5; Bible 5.1 retries). The store of what each call of a chain was asked
// for and what it made, in engine_chain_calls (migrations/0094). It is the chain's artifact store for now: engine_artifacts holds only
// the artifact types the contracts name, and none of them holds a chain output (see the migration's header).
//
// A call is recorded twice. Its spec is recorded before it is made, so a retry of the produce job builds the same spec: the same input
// hash, the same idempotency key, and the same links to the inputs (a signed link differs each time it is signed, so it must be kept).
// Its output is recorded when the call makes it: the uri the next call reads, the provider, the bill, and the ledger entry. A retry reads
// the output and makes no second call. A record is written once: a second write of a different value is refused, never overwritten.

import { z } from "zod";
import { assetSpecSchema, canonicalJson, EngineError, modelClassSchema, type AssetSpec } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

/** One finished call of a chain: what a later call may read (its uri), and what the call cost. */
export const chainOutputSchema = z.object({
  output: z.string().min(1),
  modelClass: modelClassSchema,
  uri: z.string().min(1),
  mediaType: z.string().min(1).nullable(),
  providerId: z.string().min(1),
  promptHash: z.string().min(1),
  costUsd: z.number().nonnegative(),
  costIsEstimate: z.boolean(),
  cacheHit: z.boolean(),
  ledgerEntryId: z.string().min(1).nullable(),
});
export type ChainOutput = z.infer<typeof chainOutputSchema>;

/** The key of one call: the request, the shot, the produce job's attempt, and the call's output name. */
export type ChainCallKey = {
  organizationId: string;
  requestId: string;
  shotId: string;
  attempt: number;
  output: string;
};

/** A call as recorded: its position in the chain, the spec it was made with, and its output once it has one. */
export type StoredChainCall = { callIndex: number; spec: AssetSpec; output: ChainOutput | null };

type Row = { call_index: number; spec: string; output: string | null };

function parseSpec(text: string, key: ChainCallKey): AssetSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new EngineError("internal", `the recorded spec of ${key.output} on ${key.shotId} is not JSON`, { cause: error, stage: "produce_shot" });
  }
  const parsed = assetSpecSchema.safeParse(raw);
  if (!parsed.success) throw new EngineError("internal", `the recorded spec of ${key.output} on ${key.shotId} no longer matches its contract`, { stage: "produce_shot" });
  return parsed.data;
}

function parseOutput(text: string, key: ChainCallKey): ChainOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new EngineError("internal", `the recorded output of ${key.output} on ${key.shotId} is not JSON`, { cause: error, stage: "produce_shot" });
  }
  const parsed = chainOutputSchema.safeParse(raw);
  if (!parsed.success) throw new EngineError("internal", `the recorded output of ${key.output} on ${key.shotId} is not valid`, { stage: "produce_shot" });
  return parsed.data;
}

/** The recorded call of a key, or null when none was recorded yet. Only the key's own request and workspace are read. */
export async function readChainCall(sql: Sql, key: ChainCallKey): Promise<StoredChainCall | null> {
  const rows = await sql<Row>`
    select call_index, spec, output from engine_chain_calls
    where organization_id = ${key.organizationId} and request_id = ${key.requestId} and shot_id = ${key.shotId}
      and attempt = ${key.attempt} and output_name = ${key.output}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    callIndex: Number(row.call_index),
    spec: parseSpec(row.spec, key),
    output: row.output === null ? null : parseOutput(row.output, key),
  };
}

/**
 * Records the spec of a call before the call is made, and returns the spec that is recorded. The first writer's spec stands: a call
 * recorded twice gets the first spec back, so a concurrent or repeated run makes the call the first run named.
 */
export async function recordChainSpec(sql: Sql, input: ChainCallKey & { callIndex: number; spec: AssetSpec; at: string }): Promise<AssetSpec> {
  const spec = assetSpecSchema.parse(input.spec);
  await sql`
    insert into engine_chain_calls (organization_id, request_id, shot_id, attempt, output_name, call_index, spec, created_at, updated_at)
    values (${input.organizationId}, ${input.requestId}, ${input.shotId}, ${input.attempt}, ${input.output}, ${input.callIndex},
      ${canonicalJson(spec)}, ${input.at}, ${input.at})
    on conflict (organization_id, request_id, shot_id, attempt, output_name) do nothing
  `;
  const stored = await readChainCall(sql, input);
  if (stored === null) throw new EngineError("internal", `the spec of ${input.output} on ${input.shotId} was not recorded`, { stage: "produce_shot" });
  return stored.spec;
}

/**
 * Records the output of a call the provider made. Written once: the same output again changes nothing; a different one is refused,
 * since two outputs for one call would mean the call was paid for twice.
 */
export async function recordChainOutput(sql: Sql, input: ChainCallKey & { made: ChainOutput; at: string }): Promise<void> {
  const made = chainOutputSchema.parse(input.made);
  await sql`
    update engine_chain_calls set output = ${canonicalJson(made)}, updated_at = ${input.at}
    where organization_id = ${input.organizationId} and request_id = ${input.requestId} and shot_id = ${input.shotId}
      and attempt = ${input.attempt} and output_name = ${input.output} and output is null
  `;
  const stored = await readChainCall(sql, input);
  if (stored === null) throw new EngineError("internal", `${input.output} on ${input.shotId} has no recorded call to hold its output`, { stage: "produce_shot" });
  if (stored.output === null || canonicalJson(stored.output) !== canonicalJson(made)) {
    throw new EngineError("conflict", `${input.output} on ${input.shotId} already has a different output recorded`, { stage: "produce_shot", retryable: false });
  }
}
