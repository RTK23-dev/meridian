// The `produce_shot` stage (Video Engine Bible 6.6, 10.4, 15.2). It makes one take for one shot and writes the Take artifact.
//
// Source kinds. A generate shot goes to the asset router: one paid call, against the request's reservation. A stock shot is searched
// through the stock routes (free, Bible 10.3), and the clip is downloaded through the gateway. A component or asset shot has no
// produce job; the orchestrator never queues one for it.
//
// Holds, not failures (Bible 5.1, 10.4). A budget refusal pauses the request with its reason. A content_policy or invalid_input
// refusal returns a hold with a rule-style hint, for the planner's one rewrite. Anything else that stops a take (no connected
// provider, every candidate failed, a full bucket, a duplicate call) is thrown: the job retries, and when it is dead the request
// pauses with its artifacts. Nothing is reported as a take that was not made.
//
// Output (Bible 6.6 step 4, with a limit). The file is downloaded, checked to be an mp4, probed, and kept only when it is H.264 at
// 1080 x 1920 with a known duration. Normalisation (6.6 step 4) needs a media function that is not built, so a file of another shape
// is a refusal (invalid_output), not a take that would fail later.
//
// Asynchronous providers (Bible 15.2). A generated take is submitted through the router's submit: run() returns submitted with the
// asset job as its carry, and the poller polls the provider. When the call is finished, finish() settles it through the router's
// settle, which reconciles the bill and may move the call to the next target (submitted again). One downloader takes every take:
// this handler's (gateway/download.ts). The router's own downloader is not set, so no take is downloaded twice.

import { EngineError, contentHash, type Decision } from "../../contracts/index.ts";
import type { ProviderPoll } from "../../contracts/assets.ts";
import { closingComponentProblem, libraryHas } from "../../plan/chains.ts";
import { chainOutputSchema, type ChainOutput } from "../chain-store.ts";
import { thresholds } from "../../config/thresholds.ts";
import { SINGLE_CALL_OUTPUT } from "../../plan/model-choices.ts";
import { directivesOf } from "../remake.ts";
import type { ProduceHold, StageContext, StageHandler, StageRunResult } from "../types.ts";
import { STOCK_MODEL, STOCK_COST_USD } from "./produce-shot-types.ts";
import type { ProduceShotPorts } from "./produce-shot-types.ts";
import { carriedJob, carriedDecisionsOf, storeTake, outputFor, joined, fromProduction } from "./produce-shot-take.ts";
import { assetSpecFor, planShotOf, epochFor, attemptFor, requireReservation } from "./produce-shot-spec.ts";
import { specOfCall, chainCarryOf, driveChain } from "./produce-shot-chain.ts";
import type { ChainRun } from "./produce-shot-chain.ts";

export { chainOutputSchema };
export type { ChainOutput };

export { STOCK_MODEL, STOCK_COST_USD, TAKE_MAX_BYTES, TAKE_WIDTH, TAKE_HEIGHT } from "./produce-shot-types.ts";
export type { ShotProduction, GenerateInput, ShotGenerator, StockSearch, ProduceShotPorts } from "./produce-shot-types.ts";
export { productionFromReport, routerGenerator, takeIdFor, isMp4, takeShapeOf, splitAdapterId } from "./produce-shot-take.ts";
export { promptWithHints, assetSpecFor } from "./produce-shot-spec.ts";
export { chainProgressSchema, chainCallSpecFor } from "./produce-shot-chain.ts";
export type { ChainProgress } from "./produce-shot-chain.ts";

/**
 * The produce_shot stage. run() makes the take for a generate or stock shot, or drives a chain's calls. For an asynchronous generator it
 * returns submitted, and finish() settles the call when the poller sees it done or refused.
 */
export function createProduceShotHandler(ports: ProduceShotPorts): StageHandler {
  const now = ports.now ?? Date.now;
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const { shot, planArtifactId, choices } = await planShotOf(ctx);
      const epoch = epochFor(ctx);
      const attempt = attemptFor(ctx);
      const source = shot.source;

      if (source.kind === "generate") {
        const started = now();
        const spec = assetSpecFor({
          requestId: ctx.requestId,
          shot,
          attempt,
          hints: ctx.payload.hints,
          directives: directivesOf(ctx.payload.details),
          subject: ctx.subjectId,
          modelChoice: choices.get(SINGLE_CALL_OUTPUT) ?? null,
        });
        const reservationId = requireReservation(ctx);
        const production = await ports.generator.generate({
          sql: ctx.sql,
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          reservationId,
          spec,
          visualType: shot.visualType,
        });
        if (production.status === "submitted") {
          // The router's job is the poll's carry. The poller settles the call through finish, with this job.
          return {
            kind: "submitted",
            provider: production.providerId,
            jobRef: production.jobRef,
            submittedAt: production.submittedAt,
            carry: { job: production.job, decisions: production.decisions },
          };
        }
        const { made, decisions } = await fromProduction(ctx, ports, shot, planArtifactId, attempt, production, spec, started);
        return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId,epoch, made, decisions) };
      }

      if (source.kind === "stock") {
        const started = now();
        const outcome = await ports.stock({ organizationId: ctx.organizationId, query: source.query, minDurationMs: source.minMs });
        if (outcome.status === "no_results") {
          const hold: ProduceHold = { kind: "refused", errorKind: "invalid_input", hint: "stock_no_match" };
          return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId,epoch, { kind: "hold", hold }, []) };
        }
        if (outcome.status === "not_connected") {
          throw new EngineError("config", `no stock source is connected: ${joined(outcome.reasons)}`, { retryable: false, stage: "produce_shot" });
        }
        if (outcome.status === "failed") {
          throw new EngineError("provider", `the stock search failed: ${joined(outcome.reasons)}`, { retryable: true, stage: "produce_shot" });
        }
        // The take gate checks the take's length against the shot (Bible 6.7), and a stock clip is not trimmed here, so the clip
        // must already fit: the first of the search's clips within the duration tolerance. None fitting is a refusal for the planner.
        const planned = shot.endMs - shot.startMs;
        const clip = outcome.clips.find((candidate) => Math.abs(candidate.durationMs - planned) / planned <= thresholds.take.durationTolerance.value);
        if (clip === undefined) {
          const hold: ProduceHold = { kind: "refused", errorKind: "invalid_input", hint: "stock_duration" };
          return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId,epoch, { kind: "hold", hold }, []) };
        }
        const made = await storeTake(ctx, ports, {
          shotId: shot.shotId,
          planArtifactId,
          attempt,
          providerId: outcome.providerId,
          model: STOCK_MODEL,
          url: clip.downloadUrl,
          downloadProvider: outcome.providerId,
          promptHash: contentHash(source.query),
          costUsd: STOCK_COST_USD,
          latencyMs: now() - started,
          createdAt: new Date(now()).toISOString(),
        });
        const decision: Decision = {
          at: new Date(now()).toISOString(),
          chose: `${outcome.providerId}:${clip.clipId}`,
          alternatives: [],
          reason: `the first stock clip for the query, in route order; licence ${clip.licence.status} (Bible 10.3, E2.6)`,
          by: "scorer",
        };
        return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId,epoch, made, [decision]) };
      }

      if (source.kind === "chain") {
        // Before the first call: a chain whose closing component is not drawn would pay for frames it cannot show, so it is refused here.
        const gap = closingComponentProblem(shot.visualType, ports.componentHas ?? libraryHas);
        if (gap !== null) throw new EngineError("config", `${shot.shotId}: ${gap}; no call is made`, { stage: "produce_shot", retryable: false });
        return driveChain(
          {
            ctx,
            ports,
            shot,
            calls: source.calls,
            planArtifactId,
            epoch,
            attempt,
            progress: { index: 0, startedAt: new Date((ports.now ?? Date.now)()).toISOString(), outputs: [] },
            decisions: [],
            choices,
          },
          null,
        );
      }

      throw new EngineError("invalid_input", `${shot.shotId} is a ${source.kind} shot and needs no produce job`, { stage: "produce_shot" });
    },

    async finish(ctx: StageContext, polled: ProviderPoll): Promise<StageRunResult> {
      const submission = ctx.poll;
      if (!submission) {
        throw new EngineError("internal", "produce_shot was asked to finish a call it did not submit", { stage: "produce_shot" });
      }
      const job = carriedJob(submission.carry);
      const carried = carriedDecisionsOf(submission.carry);
      const { shot, planArtifactId, choices } = await planShotOf(ctx);
      const attempt = attemptFor(ctx);
      const chain = chainCarryOf(submission.carry);
      if (chain !== null) {
        // A call of a chain: settle it, then carry on with the calls that follow (Bible 7.1). The spec is the one the call was recorded
        // with before it was submitted, so the settle checks the same spec (Bible 5.1).
        if (shot.source.kind !== "chain") throw new EngineError("internal", `${shot.shotId} carries chain progress but its source is ${shot.source.kind}`, { stage: "produce_shot" });
        const calls = shot.source.calls;
        const run: ChainRun = { ctx, ports, shot, calls, planArtifactId, epoch: epochFor(ctx), attempt, progress: chain, decisions: carried, choices };
        const built = await specOfCall(run, chain.index, chain.outputs);
        if (built.kind !== "spec") throw new EngineError("internal", `${shot.shotId} has a settled call with no recorded spec`, { stage: "produce_shot" });
        const spec = built.spec;
        const settled = await ports.generator.settle(
          { sql: ctx.sql, organizationId: ctx.organizationId, requestId: ctx.requestId, reservationId: requireReservation(ctx), spec, visualType: shot.visualType },
          job,
          polled,
        );
        if (settled.status === "submitted") {
          return {
            kind: "submitted",
            provider: settled.providerId,
            jobRef: settled.jobRef,
            submittedAt: settled.submittedAt,
            carry: { job: settled.job, decisions: [...carried, ...settled.decisions], chain },
          };
        }
        return driveChain(run, settled);
      }
      const spec = assetSpecFor({
        requestId: ctx.requestId,
        shot,
        attempt,
        hints: ctx.payload.hints,
        directives: directivesOf(ctx.payload.details),
        subject: ctx.subjectId,
        modelChoice: choices.get(SINGLE_CALL_OUTPUT) ?? null,
      });
      const production = await ports.generator.settle(
        { sql: ctx.sql, organizationId: ctx.organizationId, requestId: ctx.requestId, reservationId: requireReservation(ctx), spec, visualType: shot.visualType },
        job,
        polled,
      );
      if (production.status === "submitted") {
        // Settling moved the call to its next target: the poller schedules that poll, and nothing is written yet.
        return {
          kind: "submitted",
          provider: production.providerId,
          jobRef: production.jobRef,
          submittedAt: production.submittedAt,
          carry: { job: production.job, decisions: [...carried, ...production.decisions] },
        };
      }
      const { made, decisions } = await fromProduction(ctx, ports, shot, planArtifactId, attempt, production, spec, Date.parse(job.submittedAt));
      return { kind: "done", output: outputFor(ctx.subjectId, shot.shotId,epochFor(ctx), made, [...carried, ...decisions]) };
    },
  };
}
