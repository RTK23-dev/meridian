// The chain of calls for a shot that is made in several steps: its progress, its call specs, its links, and the drive and the
// finish of a run. Moved out of engine/jobs/handlers/produce-shot.ts unchanged (coding loop, T9b).

import { z } from "zod";
import { EngineError, assetSpecSchema, contentHash, chainInputsOf, sumUsd, type AssetSpec, type ChainCall, type ChainInput, type Decision, type ShotSpec } from "../../contracts/index.ts";
import { closingComponentOf } from "../../plan/chains.ts";
import { normaliseHttpsUrl } from "../../assets/normalise.ts";
import { chainOutputSchema, readChainCall, recordChainOutput, recordChainSpec, type ChainCallKey, type ChainOutput } from "../chain-store.ts";
import type { ModelChoice } from "../../contracts/assets.ts";
import { directivesOf, promptWithDirectives } from "../remake.ts";
import { stableId, seedFor } from "../stable-id.ts";
import type { ProduceHold, StageContext, StageRunResult } from "../types.ts";
import { TAKE_WIDTH, TAKE_HEIGHT } from "./produce-shot-types.ts";
import type { ShotProduction, ProduceShotPorts, Refused, Stored, ShotChoices } from "./produce-shot-types.ts";
import { storeTake, outputFor, fromProduction, splitAdapterId } from "./produce-shot-take.ts";
import { promptWithHints, requireReservation } from "./produce-shot-spec.ts";

export const chainProgressSchema = z.object({
  index: z.number().int().nonnegative(),
  startedAt: z.string().min(1),
  outputs: z.array(chainOutputSchema),
});

export type ChainProgress = z.infer<typeof chainProgressSchema>;

/**
 * The asset spec of one call of a chain. Its inputs are the assets it names and the outputs of the earlier calls, as their uris. `linkOf`
 * maps each such uri to the link the spec carries (the provider's fetchable URL); absent, the uri is the link.
 */
export function chainCallSpecFor(input: {
  requestId: string;
  shot: ShotSpec;
  calls: readonly ChainCall[];
  index: number;
  attempt: number;
  hints: readonly string[];
  /** The reviewer's directions for a remade shot (remake.ts). Each call of the chain gets them. Absent: none. */
  directives?: readonly string[];
  outputs: readonly ChainOutput[];
  linkOf?: (uri: string) => string;
  /** The orchestrator's model for this call (Bible 10.5). Absent or null: the route table applies. */
  modelChoice?: ModelChoice | null;
}): AssetSpec {
  const call = input.calls[input.index];
  if (call === undefined) {
    throw new EngineError("internal", `${input.shot.shotId} has no call ${input.index} in its chain`, { stage: "produce_shot" });
  }
  const linkOf = input.linkOf ?? ((uri: string) => uri);
  const resolve = (ref: ChainInput): string => linkOf(uriOfInput(ref, input.outputs, input.shot.shotId, call.output));
  // The label names the call, so each call of a chain has its own seed, spec id and cache key (the input hash, Bible 10.4).
  const label = `${input.requestId}|${input.shot.shotId}|${input.attempt}|${call.output}`;
  const firstFrame = call.firstFrame === undefined ? undefined : resolve(call.firstFrame);
  const lastFrame = call.lastFrame === undefined ? undefined : resolve(call.lastFrame);
  return assetSpecSchema.parse({
    schema: "meridian.asset_spec/v1",
    specId: stableId("asp_", `asset|${label}`),
    shotId: input.shot.shotId,
    modelClass: call.modelClass,
    prompt: promptWithDirectives(promptWithHints(call.prompt, input.hints), input.directives ?? []),
    refs: call.refs.map(resolve),
    ...(firstFrame === undefined ? {} : { firstFrame }),
    ...(lastFrame === undefined ? {} : { lastFrame }),
    durationMs: input.shot.endMs - input.shot.startMs,
    aspect: "9:16",
    width: TAKE_WIDTH,
    height: TAKE_HEIGHT,
    seed: seedFor(label),
    takes: call.takes,
    modelChoice: input.modelChoice ?? null,
  });
}

/** The uri a chain input stands for: an asset's own uri, or the uri of the earlier call of that name. An unknown name is an internal error. */

function uriOfInput(ref: ChainInput, outputs: readonly ChainOutput[], shotId: string, callName: string): string {
  if (ref.kind === "asset") return ref.uri;
  const made = outputs.find((output) => output.output === ref.output);
  if (made === undefined) {
    throw new EngineError("internal", `call ${callName} of ${shotId} reads ${ref.output}, which no earlier call made`, { stage: "produce_shot" });
  }
  return made.uri;
}

/** The record key of one call of a chain run (the request, the shot, the job's attempt and the call's output name). */

function keyOf(run: ChainRun, output: string): ChainCallKey {
  return { organizationId: run.ctx.organizationId, requestId: run.ctx.requestId, shotId: run.shot.shotId, attempt: run.attempt, output };
}

/**
 * The links for the inputs of a call that the provider reads and that are not https yet: each uri is linked once, through the ports.
 * Absent the port, there are no links and the stored uris are sent as they are (the adapter refuses what it cannot read).
 */
async function linksFor(run: ChainRun, call: ChainCall, outputs: readonly ChainOutput[]): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  const providerUrl = run.ports.providerUrl;
  if (providerUrl === undefined) return links;
  for (const input of chainInputsOf(call)) {
    const uri = uriOfInput(input, outputs, run.shot.shotId, call.output);
    if (links.has(uri) || normaliseHttpsUrl(uri).ok) continue;
    const link = await providerUrl({ organizationId: run.ctx.organizationId, uri });
    if (!normaliseHttpsUrl(link).ok) {
      throw new EngineError("invalid_input", `the link made for an input of ${call.output} is not an https URL the provider can fetch`, {
        stage: "produce_shot",
      });
    }
    links.set(uri, link);
  }
  return links;
}

/** The spec of one call, pinned by its record (Bible 5.1). See specOfCall. */

type CallSpec = { kind: "spec"; spec: AssetSpec } | { kind: "unlinked"; reason: string };

/**
 * The spec of the call at `index`. A recorded call returns the spec it was recorded with, so a retry makes the same call. A call with no
 * record is built from the outputs before it, its inputs as links, and recorded before it is made. An input that cannot be linked is
 * returned as unlinked, so the chain stops before the call with a hold; a link service that is not connected is thrown.
 */
export async function specOfCall(run: ChainRun, index: number, outputs: readonly ChainOutput[]): Promise<CallSpec> {
  const call = run.calls[index];
  if (call === undefined) throw new EngineError("internal", `${run.shot.shotId} has no call ${index} in its chain`, { stage: "produce_shot" });
  const key = keyOf(run, call.output);
  const recorded = await readChainCall(run.ctx.sql, key);
  if (recorded !== null) return { kind: "spec", spec: recorded.spec };
  let links: Map<string, string>;
  try {
    links = await linksFor(run, call, outputs);
  } catch (error) {
    if (error instanceof EngineError && error.kind === "invalid_input") return { kind: "unlinked", reason: error.message };
    throw error;
  }
  const spec = chainCallSpecFor({
    requestId: run.ctx.requestId,
    shot: run.shot,
    calls: run.calls,
    index,
    attempt: run.attempt,
    hints: run.ctx.payload.hints,
    directives: directivesOf(run.ctx.payload.details),
    outputs,
    linkOf: (uri) => links.get(uri) ?? uri,
    modelChoice: run.choices.get(call.output) ?? null,
  });
  const stored = await recordChainSpec(run.ctx.sql, { ...key, callIndex: index, spec, at: new Date((run.ports.now ?? Date.now)()).toISOString() });
  return { kind: "spec", spec: stored };
}

/** The decision that records a chain's stop at one call (Bible L7): the call, and why no later call is made. */

function stopDecisionOf(run: ChainRun, index: number, reason: string, clock: () => number): Decision {
  const call = run.calls[index];
  return {
    at: new Date(clock()).toISOString(),
    chose: `stopped at ${call?.output ?? "chain"}`,
    alternatives: [],
    reason,
    by: "scorer",
  };
}

/** What a chain run carries from one call to the next. */

export type ChainRun = {
  ctx: StageContext;
  ports: ProduceShotPorts;
  shot: ShotSpec;
  calls: readonly ChainCall[];
  planArtifactId: string;
  epoch: number;
  attempt: number;
  progress: ChainProgress;
  decisions: Decision[];
  /** The model choices of this shot's calls, by output (Bible 10.5). */
  choices: ShotChoices;
};

/** The chain's progress carried on a poll, parsed again (the poll payload is stored JSON, Bible 1). Absent for a generate shot. */

export function chainCarryOf(carry: unknown): ChainProgress | null {
  const value = typeof carry === "object" && carry !== null ? (carry as { chain?: unknown }).chain : undefined;
  if (value === undefined) return null;
  const parsed = chainProgressSchema.safeParse(value);
  if (!parsed.success) throw new EngineError("internal", "the chain progress carried by a poll does not parse", { stage: "produce_shot" });
  return parsed.data;
}

/**
 * Makes the calls of a chain in order (Bible 7.1). `settled` is the answer already in hand for the call at the progress index (a settled
 * poll), or null to make that call now. Returns submitted while a call is with the provider, the take when the last call is a video, or
 * the hold of the call that stopped the chain. Each call's ledger entry is written by the router, so every call has one (checked here).
 */
export async function driveChain(run: ChainRun, settled: ShotProduction | null): Promise<StageRunResult> {
  const { ctx, ports, shot } = run;
  let progress = run.progress;
  let decisions = run.decisions;
  let answer = settled;
  for (;;) {
    const call = run.calls[progress.index];
    if (call === undefined) return finishChain({ ...run, progress, decisions });
    const recorded = await readChainCall(ctx.sql, keyOf(run, call.output));
    if (recorded?.output) {
      // Made by an earlier run of this job: its output is read back, and no call is made for it (Bible 5.1).
      if (answer !== null) {
        throw new EngineError("conflict", `call ${call.output} of ${shot.shotId} was made by an earlier run; its settled answer is not used`, {
          stage: "produce_shot",
          retryable: false,
        });
      }
      progress = { index: progress.index + 1, startedAt: progress.startedAt, outputs: [...progress.outputs, recorded.output] };
      continue;
    }
    const built = await specOfCall(run, progress.index, progress.outputs);
    if (built.kind === "unlinked") {
      // An input the provider cannot read is a refusal before the call: nothing is spent, and the planner may rewrite the call once.
      const stop = stopDecisionOf(run, progress.index, `call ${progress.index + 1} of ${run.calls.length} (${call.modelClass}) has an input the provider cannot read: ${built.reason}; no call is made`, ports.now ?? Date.now);
      const hold: ProduceHold = { kind: "refused", errorKind: "invalid_input", hint: "unlinked_input" };
      return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId, run.epoch, { kind: "hold", hold }, [...decisions, stop]) };
    }
    const spec = built.spec;
    const production =
      answer ??
      (await ports.generator.generate({
        sql: ctx.sql,
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        reservationId: requireReservation(ctx),
        spec,
        visualType: shot.visualType,
      }));
    answer = null;

    if (production.status === "submitted") {
      return {
        kind: "submitted",
        provider: production.providerId,
        jobRef: production.jobRef,
        submittedAt: production.submittedAt,
        carry: { job: production.job, decisions: [...decisions, ...production.decisions], chain: progress },
      };
    }

    if (production.status !== "done") {
      // A refusal or a failure stops the chain here. No later call is made, and the hold names the call that stopped it.
      const { made, decisions: callDecisions } = await fromProduction(ctx, ports, shot, run.planArtifactId, run.attempt, production, spec, Date.parse(progress.startedAt));
      const named: Stored | Refused =
        made.kind === "hold" && made.hold.kind === "budget" ? { kind: "hold", hold: { kind: "budget", reason: `${call.output}: ${made.hold.reason}` } } : made;
      const stop = stopDecisionOf(
        run,
        progress.index,
        `call ${progress.index + 1} of ${run.calls.length} (${call.modelClass}) did not make an output, so no later call is made`,
        ports.now ?? Date.now,
      );
      return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId, run.epoch, named, [...decisions, ...callDecisions, stop]) };
    }

    if (!production.cacheHit && production.ledgerEntryId === null) {
      throw new EngineError("internal", `call ${call.output} of ${shot.shotId} was made with no ledger entry`, { stage: "produce_shot" });
    }
    const made: ChainOutput = {
      output: call.output,
      modelClass: call.modelClass,
      uri: production.uri,
      mediaType: production.mediaType,
      providerId: production.providerId,
      promptHash: contentHash(spec.prompt),
      costUsd: production.costUsd,
      cacheHit: production.cacheHit,
      ledgerEntryId: production.ledgerEntryId,
    };
    // The output is recorded before the next call reads it, so a retry reads it back and makes no second call (Bible 5.1).
    await recordChainOutput(ctx.sql, { ...keyOf(run, call.output), made, at: new Date((ports.now ?? Date.now)()).toISOString() });
    progress = { index: progress.index + 1, startedAt: progress.startedAt, outputs: [...progress.outputs, made] };
    decisions = [...decisions, ...production.decisions];
    if (progress.index >= run.calls.length) return finishChain({ ...run, progress, decisions });
  }
}

/**
 * The end of a chain whose calls were all made. A video last call is the shot's take: it is downloaded and checked like any take, and
 * its cost is the sum of every call. A chain that ends in an image has no take: the closing component draws the frames, and the output
 * names it (decision), with no take and no hold.
 */
async function finishChain(run: ChainRun): Promise<StageRunResult> {
  const { ctx, ports, shot } = run;
  const clock = ports.now ?? Date.now;
  const last = run.progress.outputs[run.progress.outputs.length - 1];
  const finalCall = run.calls[run.calls.length - 1];
  if (last === undefined || finalCall === undefined) {
    throw new EngineError("internal", `the chain of ${shot.shotId} ended with no output`, { stage: "produce_shot" });
  }
  if (!finalCall.modelClass.startsWith("video.")) {
    const component = closingComponentOf(shot.visualType);
    if (component === undefined) {
      throw new EngineError("invalid_input", `${shot.shotId} ends in an image and has no closing component`, { stage: "produce_shot" });
    }
    const closing: Decision = {
      at: new Date(clock()).toISOString(),
      chose: component,
      alternatives: [],
      reason: `the ${run.calls.length} frames are made; ${component} draws them after the last call, so the shot has no take (Bible 6.6)`,
      by: "scorer",
    };
    return {
      kind: "done",
      output: { stage: "produce_shot", subjectId: ctx.subjectId, shotId: shot.shotId, takeId: null, epoch: run.epoch, artifacts: {}, decisions: [...run.decisions, closing] },
    };
  }
  const { provider, model } = splitAdapterId(last.providerId);
  const made = await storeTake(ctx, ports, {
    shotId: shot.shotId,
    planArtifactId: run.planArtifactId,
    attempt: run.attempt,
    providerId: provider,
    model,
    url: last.uri,
    downloadProvider: provider,
    promptHash: last.promptHash,
    costUsd: sumUsd(run.progress.outputs.map((output) => output.costUsd)),
    latencyMs: clock() - Date.parse(run.progress.startedAt),
    createdAt: new Date(clock()).toISOString(),
  });
  return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId, run.epoch, made, run.decisions) };
}
