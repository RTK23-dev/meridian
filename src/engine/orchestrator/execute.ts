// Runs a validated plan one step at a time, in order, and reports each step as it changes. Fail closed:
// - a paid step starts only while the committed spend is below the plan's line and its own hold fits within it (D12, D17; budget/line.ts).
//   A call already in flight finishes, and its cost may take the spend past the line: that overshoot is recorded, never hidden. A hold that
//   does not fit pauses the run before its call; nothing after the paused step starts, and the steps before it still run.
// - a category the brief budgets (copy, creative, voice) has its own line, checked after the total, with the same two checks (categories.ts).
// - a paid step's hold is its engine estimate, or in measure mode its ceiling (measure.ts, D15). A paid step with no hold does not run.
// - a step whose job is already waiting at its provider (D14) reports `queued`: nothing is submitted, and it adds no spend, because its hold
//   is already in the run's starting spend.
// - a step with no handler for its kind is `not_connected`: it does not run and returns no output.
// - a step whose handler throws is `failed`, and every step that reads it is `skipped`.
// - a budget line that refuses a call pauses the run at that step (D17): the step is not failed, and nothing is held for it.
// - a step whose asset was billed before it stopped fails with the larger of its hold and its bills (BilledStopError, D12, D14). A budget
//   line that refuses it still pauses the run, after the bills are recorded.
// - an unusable cost is not a free call: a paid step charges its hold, as a failed step does.
// - each step's output is handed to onOutput as the step completes, before it counts as done. A write that throws fails the step, and its
//   cost stays counted on its failed event, so a later run counts it (D12).
// Cache hits are reported as `cache_hit` and cost nothing. The handlers are injected, so this file calls no provider.

import { contentHash } from "../contracts/hash.ts";
import { positionOfLine, startsBelowLine } from "../budget/line.ts";
import type { NodeEvent, NodeKind, NodeState, OrchestratorPlan, PlanNode } from "./contracts.ts";
import { cacheKeys } from "./dirty.ts";
import { categoryOf, type BudgetCategory, type CategoryAmounts } from "./categories.ts";
import { holdUsdOf, type MeasureOptions } from "./measure.ts";
import { KIND_CATALOG } from "./validate.ts";

/**
 * What a step produced. `outputHash` identifies it; `body` is its text content (a script, an analysis, a reference's text), or null for a
 * step with no text. A downstream step is given the body of each step it reads, never the hash.
 */
export type NodeOutput = { outputHash: string; costUsd: number | null; body?: string | null };

/**
 * Thrown by a handler whose provider is not connected, before any call is made and before any money is held. The step reports
 * not_connected and nothing is charged. Any other error is a failure, and a paid step's hold is held for it.
 */
export class NotConnectedError extends Error {
  constructor(reason: string) {
    super(reason.slice(0, REASON_MAX));
    this.name = "NotConnectedError";
  }
}

/**
 * Thrown by a handler that stopped before any call was made, or before a call was authorized: a refused budget, a call already made, a
 * missing model or upstream body. The step fails, and nothing is held, because no money was committed by it.
 */
export class CallRefusedError extends Error {
  constructor(reason: string) {
    super(reason.slice(0, REASON_MAX));
    this.name = "CallRefusedError";
  }
}

/**
 * Thrown by a handler whose asset the provider accepted but has not finished. The step is queued: its poll is durable (asset jobs), and a
 * later run finds the stored output. The step's hold is counted for this run so it cannot overrun, and nothing is stored yet.
 */
export class StepQueuedError extends Error {
  constructor(reason: string) {
    super(reason.slice(0, REASON_MAX));
    this.name = "StepQueuedError";
  }
}

/**
 * Thrown by a handler whose asset was billed before the step stopped (D12, D14): a submit the provider billed and then failed, followed by a
 * fallback that refused, queued or failed. The bills are the step's cost at least. The step fails with the larger of its hold and its bills,
 * so the plan's failed holds count them in a later run. A budget line that refused the step still pauses the run, and the bills are recorded
 * before the pause.
 */
export class BilledStopError extends Error {
  readonly billedUsd: number;
  constructor(reason: string, billedUsd: number) {
    super(reason.slice(0, REASON_MAX));
    this.name = "BilledStopError";
    this.billedUsd = billedUsd;
  }
}

/**
 * `upstream` maps each step the handler reads to its body. A null body means no content was stored: the handler must fail closed.
 * `upstreamKinds` maps the same steps to their kinds, so a handler can tell a visual or voice asset from a text answer.
 */
export type NodeHandler = (input: {
  node: PlanNode;
  key: string;
  upstream: Map<string, string | null>;
  upstreamKinds: Map<string, NodeKind>;
}) => Promise<NodeOutput>;

export type Handlers = Partial<Record<NodeKind, NodeHandler>>;

/** Outputs kept between runs, by cache key. A cache hit reuses an output of an identical step. */
export type RunCache = Map<string, NodeOutput>;

/** A step's new output as it completes, for the store (run.ts). `costUsd` is the charged cost, the cost the stored output keeps. */
export type CompletedOutput = {
  nodeId: string;
  cacheKey: string;
  outputHash: string;
  costUsd: number | null;
  body: string | null;
  category: BudgetCategory | null;
};

export type RunResult = {
  status: "complete" | "paused" | "incomplete";
  /** What the run has spent. A step that reports no actual cost is charged its hold, so the run never assumes a free call. */
  spentUsd: number;
  outputs: Map<string, string>;
};

const REASON_MAX = 300;

/** The reason of a step whose job is still waiting at its provider (D14): its hold is already counted, so nothing is submitted. */
function queuedReason(kind: NodeKind): string {
  return `the ${kind} is still queued at its provider; its hold is already counted, so nothing is submitted; run the plan again once its poll has settled it`;
}

/**
 * Why a paid step may not start against one line (D12, D17): the committed spend is at or past the line, or the step's own hold would take
 * the committed spend past it. Null when the step may start. The text is the pause's reason; a category line names its category in it.
 */
function blockOf(committedUsd: number, holdUsd: number, lineUsd: number, category: BudgetCategory | null): string | null {
  if (startsBelowLine(committedUsd, lineUsd) && positionOfLine(committedUsd + holdUsd, lineUsd) === "within_budget") return null;
  const name = category === null ? "" : `${category} `;
  return `${name}budget reached, project not finished: the next step's hold of $${holdUsd.toFixed(4)} would take the spend past the $${lineUsd.toFixed(4)} ${name}budget (committed $${committedUsd.toFixed(4)})`;
}

/** The budget's line refusal, as budget/reserve.ts words it: a line is reached, or the call's own hold would take it past. */
const BUDGET_LINE_REFUSAL = /budget, so (?:no paid call starts|it does not start)/;

/** What production.ts puts before the budget's own reason in a refused call's message. */
const REFUSED_BEFORE_REASON = "so it was not made: ";

/**
 * The budget's reason when a call was refused by a budget line (D17), or null for any other refusal. A line refusal pauses the run at its
 * step; any other refusal fails the step. The reason is the budget's own words, which carry the committed amount and the line.
 */
function budgetLineRefusalOf(message: string): string | null {
  if (!BUDGET_LINE_REFUSAL.test(message)) return null;
  const at = message.indexOf(REFUSED_BEFORE_REASON);
  return at === -1 ? message : message.slice(at + REFUSED_BEFORE_REASON.length);
}

export async function runPlan(opts: {
  plan: OrchestratorPlan;
  order: string[];
  handlers: Handlers;
  cache: RunCache;
  emit: (event: NodeEvent) => void;
  /** What earlier runs of this plan committed: the stored outputs, the failed holds and the waiting holds (run.ts). */
  spentUsd?: number;
  /** The plan's line: the lower of its budget and the budget the user set (envelope.ts lineOf). Absent: the plan's own budget. */
  lineUsd?: number;
  /** The line of each category the brief sets (categories.ts categoryBudgetsOf). A category not listed has no line of its own. */
  categoryLinesUsd?: CategoryAmounts;
  /** What earlier runs committed in each category (categories.ts categorySpentOf). */
  categorySpentUsd?: CategoryAmounts;
  /** The steps with a job waiting at their provider (holds.ts waitingHoldsByNode). They report queued, submit nothing and add no spend. */
  queued?: ReadonlySet<string>;
  /** Measure mode (D15). Absent or null: off. */
  measure?: MeasureOptions | null;
  /**
   * Handed each step's new output as the step completes, before the step counts as done (run.ts stores it). Awaited: a write that throws
   * fails the step, and its cost is still counted on its failed event (D12). Absent: the outputs are kept in the run's cache only.
   */
  onOutput?: (output: CompletedOutput) => Promise<void>;
}): Promise<RunResult> {
  const { plan, order, handlers, cache, emit } = opts;
  const line = opts.lineUsd ?? plan.budgetUsd;
  const categoryLines: CategoryAmounts = opts.categoryLinesUsd ?? {};
  const categorySpent: CategoryAmounts = { ...opts.categorySpentUsd };
  const queued: ReadonlySet<string> = opts.queued ?? new Set<string>();
  const measure = opts.measure ?? null;
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const keys = cacheKeys(plan, order);
  const states = new Map<string, NodeState>();
  const outputs = new Map<string, string>();
  const bodies = new Map<string, string | null>();
  let spent = opts.spentUsd ?? 0;

  const set = (nodeId: string, state: NodeState, outputHash: string | null, costUsd: number | null, reason: string | null) => {
    states.set(nodeId, state);
    emit({ nodeId, state, outputHash, costUsd, reason });
  };

  // Spend counts toward the total, and toward the step's category when it has one.
  const addSpend = (category: BudgetCategory | null, usd: number) => {
    spent += usd;
    if (category !== null) categorySpent[category] = (categorySpent[category] ?? 0) + usd;
  };

  for (const id of order) set(id, "planned", null, null, null);

  let paused = false;
  for (const id of order) {
    const node = byId.get(id);
    if (!node) throw new Error(`no step ${id} in this plan`);

    const blocker = node.dependsOn.find((dep) => states.get(dep) !== "done" && states.get(dep) !== "cache_hit");
    if (blocker !== undefined) {
      set(id, "skipped", null, null, `waits on ${blocker}, which did not finish`);
      continue;
    }

    const key = keys.get(id);
    if (key === undefined) throw new Error(`no cache key for step ${id}`);

    const hit = cache.get(key);
    if (hit !== undefined) {
      outputs.set(id, hit.outputHash);
      bodies.set(id, hit.body ?? null);
      set(id, "cache_hit", hit.outputHash, 0, null);
      continue;
    }

    // A job already waiting at its provider (D14): its hold is in the starting spend, so the step submits nothing and adds nothing. It
    // is not held by the line, because it spends nothing now.
    if (queued.has(id)) {
      set(id, "queued", null, null, queuedReason(node.kind));
      continue;
    }

    const category = categoryOf(node.kind);
    const paidKind = KIND_CATALOG[node.kind] !== undefined;
    // A paid step's hold: its engine estimate, or in measure mode its ceiling (D15). Null when neither applies: the step does not run.
    const hold = paidKind ? holdUsdOf(node, measure) : null;
    if (paidKind && hold === null) {
      set(id, "failed", null, null, `the step has no price, and measure mode ${measure === null ? "is off" : "does not hold it"}, so it did not run`);
      continue;
    }

    // The lines (D12, D17). A paid step starts only while the committed spend is below its line and its own hold fits within it. The total
    // is checked first, then the step's category line. The check runs before the handler, so a line reached before the run pauses at its
    // first paid step whatever is wired. A step that does not fit pauses the run before its call, and nothing after it starts.
    if (paidKind && hold !== null) {
      const totalBlock = blockOf(spent, hold, line, null);
      if (totalBlock !== null) {
        set(id, "paused", null, null, totalBlock);
        paused = true;
        break;
      }
      const categoryLine = category === null ? undefined : categoryLines[category];
      if (category !== null && categoryLine !== undefined) {
        const categoryBlock = blockOf(categorySpent[category] ?? 0, hold, categoryLine, category);
        if (categoryBlock !== null) {
          set(id, "paused", null, null, categoryBlock);
          paused = true;
          break;
        }
      }
    }

    const handler = handlers[node.kind];
    if (handler === undefined) {
      set(id, "not_connected", null, null, `no handler for ${node.kind} steps; the step did not run and has no output`);
      continue;
    }

    set(id, "running", null, null, null);
    try {
      const upstream = new Map(node.dependsOn.map((dep) => [dep, bodies.get(dep) ?? null]));
      const upstreamKinds = new Map<string, NodeKind>();
      for (const dep of node.dependsOn) {
        const kind = byId.get(dep)?.kind;
        if (kind !== undefined) upstreamKinds.set(dep, kind);
      }
      const output = await handler({ node, key, upstream, upstreamKinds });
      // A handler's reported cost is data: it must be a finite number, not negative. Null means no actual cost was reported, so the hold is
      // charged. An unusable figure is not a free call either: a paid step charges its hold, as a failed step does (D12, fail closed).
      const reported = output.costUsd ?? null;
      if (reported !== null && !(Number.isFinite(reported) && reported >= 0)) {
        const held = paidKind ? hold : null;
        if (held !== null) addSpend(category, held);
        set(id, "failed", null, held, "the step reported an unusable cost");
        continue;
      }
      // A paid step keeps its charged cost on the stored output, so a later run can total the plan's spend from its stored outputs alone.
      const charged = paidKind ? (reported ?? hold ?? 0) : reported;
      const body = output.body ?? null;
      // The bill is spent from here, whether or not its output can be kept: the spend counts it before the write is attempted.
      addSpend(category, charged ?? 0);
      try {
        await opts.onOutput?.({ nodeId: id, cacheKey: key, outputHash: output.outputHash, costUsd: charged, body, category });
      } catch (writeError) {
        // The output is not kept, so nothing is cached and the steps that read it wait. The cost is not dropped: the failed event carries the
        // charged cost, and a later run counts it as a failed hold.
        const message = writeError instanceof Error ? writeError.message : "the write failed";
        set(id, "failed", null, charged, `the output could not be stored, so the step is not kept: ${message}`.slice(0, REASON_MAX));
        continue;
      }
      cache.set(key, { outputHash: output.outputHash, costUsd: charged, body });
      outputs.set(id, output.outputHash);
      bodies.set(id, body);
      set(id, "done", output.outputHash, charged, null);
    } catch (error) {
      // No provider is connected: the handler stopped before any call, so nothing is held and nothing is kept.
      if (error instanceof NotConnectedError) {
        set(id, "not_connected", null, null, error.message);
        continue;
      }
      // Accepted by the provider, not finished: queued. The hold is counted for this run; the stored output comes when the poll settles it.
      if (error instanceof StepQueuedError) {
        if (paidKind && hold !== null) addSpend(category, hold);
        set(id, "queued", null, null, error.message);
        continue;
      }
      // The asset was billed before the step stopped (D12, D14). Its bills are the cost at least: the failed event carries the larger of the hold
      // and the bills, and nothing billed is dropped. A budget line that refused the step pauses the run after the bills are recorded, and
      // nothing is held for the paused call. An unusable bill is not a free call: the hold is charged, as an unusable cost is.
      if (error instanceof BilledStopError) {
        const billed = error.billedUsd;
        if (!(Number.isFinite(billed) && billed >= 0)) {
          const held = paidKind ? hold : null;
          if (held !== null) addSpend(category, held);
          set(id, "failed", null, held, "the step reported an unusable bill");
          continue;
        }
        const refusal = budgetLineRefusalOf(error.message);
        if (refusal !== null) {
          if (billed > 0) {
            addSpend(category, billed);
            set(id, "failed", null, billed, `billed $${billed.toFixed(4)} before a budget line refused its next call`);
          }
          set(id, "paused", null, null, `budget reached, project not finished: ${refusal}`);
          paused = true;
          break;
        }
        const cost = paidKind && hold !== null ? Math.max(hold, billed) : billed;
        addSpend(category, cost);
        set(id, "failed", null, cost, error.message.slice(0, REASON_MAX));
        continue;
      }
      // A refusal before any call. A budget line that refused it pauses the run at this step (D17): the step is not failed, and nothing was
      // committed, so nothing is held. Any other refusal fails the step, with no hold, because nothing was committed.
      if (error instanceof CallRefusedError) {
        const refusal = budgetLineRefusalOf(error.message);
        if (refusal !== null) {
          set(id, "paused", null, null, `budget reached, project not finished: ${refusal}`);
          paused = true;
          break;
        }
        set(id, "failed", null, null, error.message);
        continue;
      }
      // A paid step's hold is kept even though its call threw: the provider may have billed the call before the error. The held amount is
      // recorded on the failed event, so a later run counts it in the plan's spend.
      const held = paidKind ? hold : null;
      if (held !== null) addSpend(category, held);
      const message = error instanceof Error ? error.message : "the step failed";
      set(id, "failed", null, held, message.slice(0, REASON_MAX));
    }
  }

  const finished = order.every((id) => states.get(id) === "done" || states.get(id) === "cache_hit");
  const status = paused ? "paused" : finished ? "complete" : "incomplete";
  return { status, spentUsd: spent, outputs };
}

/** A stable hash of a run's outputs, for a test or a log line that says what the run produced. */
export function runFingerprint(outputs: Map<string, string>): string {
  return contentHash([...outputs.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
