// Asks the orchestrating model (the one the user chose) for a plan, and treats the answer as untrusted data. The model call is passed
// in, so this file calls no provider: in production the gateway makes the call, in tests a recorded answer is returned.
//
// Fail closed at every step:
// - no reply, or a reply that is not JSON, gives no plan;
// - a reply that does not match the plan schema gives no plan, with the schema's paths;
// - a plan that does not validate against the live catalog gives no plan, with every reason.
// Nothing from the reply is executed. The reply is never shown back to the model or logged here.

import type { CatalogEntry, CatalogKind } from "./catalog.ts";
import { orchestratorPlanSchema, type ModelRef, type OrchestratorPlan } from "./contracts.ts";
import { validatePlan, KIND_CATALOG } from "./validate.ts";

/** What the user gave the run: the format to rebuild or make, their inputs, and Meridian's brand and product context. */
export type PlannerBrief = {
  goal: string;
  format: string;
  userInputs: string;
  brand: { name: string; summary: string };
  budgetUsd: number;
};

/** One text completion from the orchestrating model. Injected: production passes the gateway's call, tests pass a recording. */
export type ModelCall = (input: { model: ModelRef; system: string; user: string }) => Promise<{ text: string }>;

export type PlanOutcome = { ok: true; plan: OrchestratorPlan; order: string[] } | { ok: false; reasons: string[] };

const MAX_LISTED_PER_KIND = 40;

/** The live candidates the model may choose from, by kind. Ids and names only: the catalog's prices are not in the prompt. */
export function candidateList(catalog: Map<string, CatalogEntry>): string {
  const kinds: CatalogKind[] = ["text", "image", "speech", "video"];
  return kinds
    .map((kind) => {
      const rows = [...catalog.values()].filter((entry) => entry.kind === kind).slice(0, MAX_LISTED_PER_KIND);
      return `${kind} models (${rows.length} shown):\n${rows.map((row) => `- ${row.id}`).join("\n")}`;
    })
    .join("\n\n");
}

export function buildPlannerPrompt(brief: PlannerBrief, catalog: Map<string, CatalogEntry>): { system: string; user: string } {
  const stepKinds = Object.keys(KIND_CATALOG).join(", ");
  const system = [
    "You plan a short branded video as a graph of steps. Reply with one JSON object and nothing else.",
    'The object has: "version": "orchestrator-plan@1"; "orchestrator": {"provider": "openrouter", "id": <your own model id>};',
    '"budgetUsd": a number; "nodes": an array of steps.',
    'Each step has: "id" (lowercase slug), "kind", "title", "why", "dependsOn" (ids of earlier steps), "model" ({"provider":"openrouter","id":...} or null),',
    '"params" (flat object of strings, numbers, booleans or null), "estimateUsd" (a number, or null when you do not know the cost).',
    `Step kinds: reference, analysis, script, visual, video, voice, avatar, edit, compose, render. Kinds that call a model are: ${stepKinds}.`,
    "Use only model ids from the candidate list below. A step that makes no model call has model null.",
    "If you do not know a step's cost, say null: such a step will not run.",
  ].join("\n");
  const user = [
    `Goal: ${brief.goal}`,
    `Format to rebuild or make: ${brief.format}`,
    `User inputs: ${brief.userInputs}`,
    `Brand: ${brief.brand.name}. ${brief.brand.summary}`,
    `Budget (USD): ${brief.budgetUsd}`,
    "",
    "Candidate models from the live catalog:",
    candidateList(catalog),
  ].join("\n");
  return { system, user };
}

/** The first JSON object in the reply. The reply is untrusted, so the object is only parsed, never run. */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function planWithModel(opts: {
  orchestrator: ModelRef;
  brief: PlannerBrief;
  catalog: Map<string, CatalogEntry>;
  call: ModelCall;
}): Promise<PlanOutcome> {
  const { system, user } = buildPlannerPrompt(opts.brief, opts.catalog);

  let reply: { text: string };
  try {
    reply = await opts.call({ model: opts.orchestrator, system, user });
  } catch (error) {
    const message = error instanceof Error ? error.message : "the call failed";
    return { ok: false, reasons: [`the orchestrating model did not answer: ${message.slice(0, 300)}`] };
  }

  const raw = extractJsonObject(reply.text);
  if (raw === null) return { ok: false, reasons: ["the orchestrating model's reply is not a JSON plan"] };

  const parsed = orchestratorPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`);
    return { ok: false, reasons: ["the plan does not match the schema", ...paths] };
  }

  const checked = validatePlan(parsed.data, opts.catalog);
  if (!checked.ok) return { ok: false, reasons: checked.reasons };
  return { ok: true, plan: checked.plan, order: checked.order };
}
