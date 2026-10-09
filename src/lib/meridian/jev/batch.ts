/**
 * Batch JEV Execution
 *
 * Evaluates multiple records and questions together in bounded batches
 * to minimize network roundtrips and cost, while preserving individual
 * answer persistence and lineage.
 */

import type {
  JevClient,
  JevDecisionRequest,
  JevDecisionResponse,
  JevQuestionSpec,
  JevProviderRouter,
  JevRoutingPolicy,
} from "./types.ts";
import { jevRouter } from "./router.ts";

export type BatchJevRecord = {
  id: string;
  record: string;
  availableEvidence?: string[];
  [key: string]: unknown;
};

export type BatchJevInput = {
  organizationId: string;
  brandId: string;
  description: string;
  records: BatchJevRecord[];
  questions: Record<string, JevQuestionSpec>;
  maxBatchSize?: number;
};

export async function executeBatchJev(
  clientOrRouter: JevClient | JevProviderRouter = jevRouter,
  input: BatchJevInput,
  policy?: JevRoutingPolicy,
): Promise<JevDecisionResponse[]> {
  const maxBatchSize = input.maxBatchSize ?? 10;
  const batches: BatchJevRecord[][] = [];

  for (let i = 0; i < input.records.length; i += maxBatchSize) {
    batches.push(input.records.slice(i, i + maxBatchSize));
  }

  // If no records, run single request on the global state
  if (batches.length === 0) {
    const singleReq: JevDecisionRequest = {
      organizationId: input.organizationId,
      brandId: input.brandId,
      state: {
        description: input.description,
      },
      questions: input.questions,
    };
    const res = await (clientOrRouter as any).decide(singleReq, policy);
    return [res];
  }

  const responses: JevDecisionResponse[] = [];
  for (const batch of batches) {
    const req: JevDecisionRequest = {
      organizationId: input.organizationId,
      brandId: input.brandId,
      state: {
        description: input.description,
        records: batch,
      },
      questions: input.questions,
    };

    const res = await (clientOrRouter as any).decide(req, policy);
    responses.push(res);
  }

  return responses;
}
