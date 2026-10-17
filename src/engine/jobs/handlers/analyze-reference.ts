// The `analyze_reference` stage handler (Bible 6.2, gate dna 12.1). It reads the production_request artifact (its only input,
// Bible 5.1), runs the reference analysis (analyze/reference.ts) with the ports the worker wires, and writes the video_dna
// artifact when the dna gate passes. A failing gate writes nothing: the orchestrator routes the failure (Bible 5.3).
//
// A stage that cannot run because a service is not connected throws a config error whose message starts with NOT_CONNECTED.
// Nothing was spent by then (the connection is checked before the first paid call), so the job is dead with that reason.

import {
  EngineError,
  productionRequestSchema,
  type ArtifactType,
  type ProductionRequest,
} from "../../contracts/index.ts";
import { analyzeReference, ANALYZE_STAGE, type ReferencePorts } from "../../analyze/reference.ts";
import { NOT_CONNECTED, notConnectedReason } from "../../media/stt-connection.ts";
import { readArtifact, writeArtifact, type StoredArtifact } from "../artifact-store.ts";
import type { StageContext, StageHandler, StageRunResult } from "../types.ts";

/** The one input artifact of a type. An input that is not of that type is skipped; none of the type is refused. */
async function readInputOfType(ctx: StageContext, type: ArtifactType): Promise<StoredArtifact> {
  for (const artifactId of ctx.payload.inputArtifactIds) {
    const stored = await readArtifact(ctx.sql, { organizationId: ctx.organizationId, artifactId });
    if (stored.envelope.type === type) return stored;
  }
  throw new EngineError(
    "invalid_input",
    `${ctx.stage} needs its ${type} input artifact, and none of its inputs is one`,
    { stage: ctx.stage },
  );
}

/** The job attempt as a number. The attempt is the infrastructure attempt (Bible 5.1), so an unreadable one is refused. */
function attemptNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new EngineError(
      "invalid_input",
      `the job attempt ${value} is not a whole number from 1`,
      { stage: ANALYZE_STAGE },
    );
  }
  return parsed;
}

/** The production request, parsed. An artifact that does not parse is an internal fault, never a request to guess from. */
function requestOf(body: unknown): ProductionRequest {
  const parsed = productionRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new EngineError(
      "internal",
      `the production request artifact does not parse: ${parsed.error.message}`,
      { stage: ANALYZE_STAGE },
    );
  }
  return parsed.data;
}

/**
 * The ports of the analysis for one job's reservation (production: the role deps and the ledger are per reservation). A fixed ReferencePorts
 * serves every job (tests).
 */
export type ReferencePortsFor = (scope: { organizationId: string; requestId: string; reservationId: string }) => ReferencePorts;

/** The analyze_reference stage. Pass the ports the worker wires (ReferencePorts, or a function of the job's reservation); a port that is not connected fails closed. */
export function createAnalyzeReferenceHandler(portsOrFor: ReferencePorts | ReferencePortsFor): StageHandler {
  return {
    async run(ctx: StageContext): Promise<StageRunResult> {
      const reservationId = ctx.payload.budgetReservationId;
      if (reservationId === null) {
        throw new EngineError(
          "conflict",
          "analyze_reference is a paid stage and needs a budget reservation on the request",
          { stage: ctx.stage },
        );
      }
      const ports =
        typeof portsOrFor === "function"
          ? portsOrFor({ organizationId: ctx.organizationId, requestId: ctx.requestId, reservationId })
          : portsOrFor;
      const stored = await readInputOfType(ctx, "production_request");
      const request = requestOf(stored.envelope.body);
      const outcome = await analyzeReference(
        {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          reservationId,
          attempt: attemptNumber(ctx.payload.attempt),
          subjectId: ctx.subjectId,
          request,
        },
        ports,
      );
      if (outcome.status === "not_connected") {
        const reason = outcome.reason.startsWith(NOT_CONNECTED)
          ? outcome.reason
          : notConnectedReason(outcome.reason);
        throw new EngineError("config", reason, { stage: ctx.stage });
      }
      const artifacts: Record<string, string> = {};
      if (outcome.gate.pass && outcome.dna !== null) {
        const written = await writeArtifact(ctx.sql, {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          stage: ctx.stage,
          type: "video_dna",
          body: outcome.dna,
          parentIds: [stored.envelope.artifactId],
          createdAt: ports.roles.now(),
        });
        artifacts.dna = written.artifactId;
      }
      return {
        kind: "done",
        output: {
          stage: "analyze_reference",
          subjectId: ctx.subjectId,
          artifacts,
          gate: outcome.gate,
        },
      };
    },
  };
}
