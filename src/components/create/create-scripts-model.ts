import type { RunCard } from "../../lib/meridian/direction/service.ts";
import type { ScriptCard } from "../../lib/meridian/direction/scripts-view.ts";
import type { SeatsOutcome } from "../../lib/meridian/direction/seats.ts";

/**
 * The Scripts panel's rules, kept pure so they can be tested without a browser: how versions group, and how a run, a cost and a seat
 * are put in words.
 */

export const OPTION_COUNTS = [1, 2, 3, 4] as const;

export const JOB_CHOICES = [
  { value: "reach", label: "Reach", hint: "New viewers: a broad idea people stop for and send on." },
  { value: "follow", label: "Follow", hint: "Followers: an idea worth saving, with more to come." },
  { value: "convert", label: "Convert", hint: "Buyers: a narrow pain, and one offer at the end." },
] as const;

/** A lineage: the first version of a script and every revision of it, oldest first. */
export type ScriptLineage = { rootId: string; rank: number | null; runId: string; versions: ScriptCard[] };

/** Groups scripts by lineage (a revision's parent chain), best-ranked first, then newest. Each lineage lists its versions oldest first. */
export function lineagesOf(scripts: readonly ScriptCard[]): ScriptLineage[] {
  const byId = new Map(scripts.map((script) => [script.id, script]));
  const rootOf = (script: ScriptCard): ScriptCard => {
    let current = script;
    const seen = new Set<string>();
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId)!;
    }
    return current;
  };
  const groups = new Map<string, ScriptLineage>();
  for (const script of scripts) {
    const root = rootOf(script);
    const group = groups.get(root.id) ?? { rootId: root.id, rank: root.rank, runId: root.runId, versions: [] };
    group.versions.push(script);
    groups.set(root.id, group);
  }
  const runOrder = new Map<string, number>();
  for (const script of scripts) if (!script.parentId && !runOrder.has(script.runId)) runOrder.set(script.runId, Date.parse(script.createdAt));
  return [...groups.values()]
    .map((group) => ({ ...group, versions: [...group.versions].sort((a, b) => a.version - b.version || a.createdAt.localeCompare(b.createdAt)) }))
    .sort((a, b) => (runOrder.get(b.runId) ?? 0) - (runOrder.get(a.runId) ?? 0) || (a.rank ?? 99) - (b.rank ?? 99));
}

/** Seconds with one decimal, from milliseconds: 2100 is "2.1s". */
export function seconds(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
}

/** A provider-reported cost in words. Unknown is said, never shown as $0. */
export function costWords(run: Pick<RunCard, "status" | "costUsd" | "calls">): string {
  if (run.status === "queued") return "Nothing spent yet.";
  if (run.status === "running") return `${run.calls > 0 ? `${run.calls} model calls so far. ` : ""}The cost is known when the run ends.`;
  if (run.costUsd === null) return "The cost is unknown: a call's cost was not reported. The workspace's ledger holds every call.";
  return `$${run.costUsd.toFixed(2)}, as the provider reported it.`;
}

export const RUN_STATUS_WORDS: Record<RunCard["status"], string> = {
  queued: "Waiting for the worker",
  running: "Writing",
  ready: "Ready",
  needs_person: "Needs your choice",
  failed: "Did not finish",
};

/** The badge of a script: whether it can be used, and why not. */
export function scriptState(script: Pick<ScriptCard, "blocked" | "ships" | "state">): { label: string; variant: "success" | "warning" | "danger" | "info" } {
  if (script.state === "chosen") return { label: "In the draft", variant: "info" };
  if (script.blocked) return { label: "Blocked: revise it", variant: "danger" };
  if (script.ships) return { label: "Passed every check", variant: "success" };
  return { label: "Passed the checks; the swipe test has notes", variant: "warning" };
}

/** Who writes and judges, in one line, or why no run can start. */
export function seatWords(outcome: SeatsOutcome | null): string {
  if (outcome === null) return "Checking the models...";
  if (!outcome.ok) return outcome.reason;
  const view = outcome.seats.view;
  const writers = view.secondWriter && view.secondWriter !== view.writer ? `${view.writer} and ${view.secondWriter}` : `${view.writer} (one family: choose a second script writer in Settings for more range)`;
  const judge = view.judgeAuto ? `${view.judge} (Auto: the same model judges its own ideas; choose a script judge in Settings)` : view.judge;
  return `Writers: ${writers}. Judge: ${judge}.`;
}

/** Why the write button cannot be pressed, or null. */
export function writeBlock(input: { canAdmin: boolean; draft: boolean; working: boolean; seats: SeatsOutcome | null; maxSeconds: number; language: string }): string | null {
  if (!input.canAdmin) return "Only a workspace admin can write scripts: a run spends from the workspace's budget.";
  if (!input.draft) return "This draft has started its video, so its script is set.";
  if (input.working) return "A run is working on this draft.";
  if (input.seats === null) return "Checking the models.";
  if (!input.seats.ok) return input.seats.reason;
  if (!Number.isInteger(input.maxSeconds) || input.maxSeconds < 5 || input.maxSeconds > 180) return "Set a length from 5 to 180 seconds.";
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(input.language)) return "Set the language as a tag, for example en or pt-BR.";
  return null;
}

/** The write button's words. */
export function writeLabel(count: number): string {
  return count === 1 ? "Write a script" : `Write ${count} scripts to choose from`;
}
