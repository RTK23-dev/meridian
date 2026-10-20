// A recorded example run of the sample plan, for the screen to replay. Every handler is a stand-in: it returns a deterministic
// output hash and calls no provider, and the costs shown are the plan's estimates, not charges. The run uses the same executor a
// live run uses, so the events the canvas draws have the same shape.

import { contentHash } from "../contracts/hash.ts";
import { NODE_KINDS, orchestratorPlanSchema, type NodeEvent, type OrchestratorPlan } from "./contracts.ts";
import { examplePlanRaw } from "./fixtures/example-plan.ts";
import { runPlan, type Handlers, type NodeHandler } from "./execute.ts";
import { topologicalOrder } from "./validate.ts";

export const examplePlan: OrchestratorPlan = orchestratorPlanSchema.parse(examplePlanRaw);

const standIn: NodeHandler = async ({ node }) => ({ outputHash: contentHash({ id: node.id, kind: node.kind }), costUsd: null });

export async function recordedExampleRun(): Promise<{ plan: OrchestratorPlan; events: NodeEvent[] }> {
  const order = topologicalOrder(examplePlan.nodes);
  if (order === null) throw new Error("the example plan has a cycle");
  const handlers: Handlers = Object.fromEntries(NODE_KINDS.map((kind) => [kind, standIn])) as Handlers;
  const events: NodeEvent[] = [];
  await runPlan({ plan: examplePlan, order, handlers, cache: new Map(), emit: (event) => events.push(event) });
  return { plan: examplePlan, events };
}
