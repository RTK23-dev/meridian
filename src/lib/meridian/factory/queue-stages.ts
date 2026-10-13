/**
 * Queues a Factory run's stages again, from one stage to the end of the graph (NORTH_STAR section 8, item 11). Approval and a restart
 * after a stop both use it. The first stage has no dependency, because the stages before it have already succeeded, and each later
 * stage waits on the one before it. Each job key carries the request's kind and token, so a repeated request queues nothing new.
 */

import type { Sql } from "../learning/store.ts";
import { FACTORY_GRAPH, type FactoryStage } from "./pipeline.ts";

export async function queueStagesFrom(
  sql: Sql,
  input: { organizationId: string; brandId: string; runId: string; niche: string; fromStage: FactoryStage; kind: "approval" | "resume"; token: string },
): Promise<number> {
  const remaining = FACTORY_GRAPH.slice(FACTORY_GRAPH.findIndex((spec) => spec.type === input.fromStage));
  const idByKey = new Map<string, string>();
  for (const spec of remaining) {
    const id = globalThis.crypto.randomUUID();
    const key = `factory:${input.brandId}:${input.runId}:${spec.type}:${input.kind}:${input.token}`;
    idByKey.set(key, id);
    const dependsOnKey = spec.type === input.fromStage
      ? null
      : `factory:${input.brandId}:${input.runId}:${spec.dependsOn}:${input.kind}:${input.token}`;
    await sql`
      insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts, depends_on, priority)
      values (
        ${id}, ${input.organizationId}, ${input.brandId}, ${spec.type}, ${key}, 'queued',
        ${JSON.stringify({ organizationId: input.organizationId, brandId: input.brandId, runId: input.runId, niche: input.niche, stage: spec.type })},
        ${spec.maxAttempts}, ${dependsOnKey ? idByKey.get(dependsOnKey) ?? "" : ""}, ${20 + FACTORY_GRAPH.indexOf(spec)}
      )
      on conflict (organization_id, idempotency_key) do nothing
    `;
  }
  return remaining.length;
}
