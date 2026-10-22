// The view rules of the orchestrator's canvas and its starting screen: what each step kind looks like, what each state means, how a cost
// and a zoom are shown, what the composer needs before it can plan, and how a planning outcome is said. Pure and browser-safe (no React,
// no node:* imports), so the rules are tested here and the components only draw them. Nothing in this file names a model.

import type { NodeKind, NodeState } from "../../engine/orchestrator/contracts.ts";

/** A colour role. Each one is a theme token from styles.css, so the light and dark themes both read. */
export type Accent = "muted" | "info" | "success" | "warning" | "danger" | "accent";

/** The classes of each colour role. Every class is written out in full so the Tailwind scanner finds it. */
export const ACCENT: Record<Accent, { text: string; soft: string; dot: string; stroke: string }> = {
  muted: { text: "text-fg-muted", soft: "bg-surface-2", dot: "bg-border-strong", stroke: "stroke-border-strong" },
  info: { text: "text-info", soft: "bg-info-soft", dot: "bg-info", stroke: "stroke-info" },
  success: { text: "text-success", soft: "bg-success-soft", dot: "bg-success", stroke: "stroke-success" },
  warning: { text: "text-warning", soft: "bg-warning-soft", dot: "bg-warning", stroke: "stroke-warning" },
  danger: { text: "text-danger", soft: "bg-danger-soft", dot: "bg-danger", stroke: "stroke-danger" },
  accent: { text: "text-accent", soft: "bg-accent-soft", dot: "bg-accent", stroke: "stroke-accent" },
};

/** The name of an icon for a step kind. The canvas parts file maps each name to its icon component. */
export type KindIconName = "source" | "scan" | "text" | "image" | "video" | "audio" | "person" | "cut" | "layout" | "film";

export type KindStyle = { label: string; accent: Accent; icon: KindIconName; summary: string };

/** One line per step kind: its label, colour, icon and what it does. Change a colour or an icon here and every screen follows. */
export const KIND_STYLE: Record<NodeKind, KindStyle> = {
  reference: { label: "Reference", accent: "muted", icon: "source", summary: "Material you supply. No model call." },
  analysis: { label: "Analysis", accent: "info", icon: "scan", summary: "A text model reads material and returns its structure." },
  script: { label: "Script", accent: "info", icon: "text", summary: "A text model writes the lines or the shot list." },
  visual: { label: "Still", accent: "success", icon: "image", summary: "An image model makes or edits a still." },
  video: { label: "Shot", accent: "accent", icon: "video", summary: "A video model makes a moving shot." },
  voice: { label: "Voice", accent: "warning", icon: "audio", summary: "A speech model reads the script." },
  avatar: { label: "Presenter", accent: "accent", icon: "person", summary: "A video model makes a presenter shot." },
  edit: { label: "Edit", accent: "muted", icon: "cut", summary: "Deterministic cut, timing and grade. No model call." },
  compose: { label: "Compose", accent: "muted", icon: "layout", summary: "Deterministic layout of stills, shots and captions. No model call." },
  render: { label: "Render", accent: "success", icon: "film", summary: "The final encode. No model call." },
};

/** The step kinds in the order a reader meets them. */
export const NODE_KIND_ORDER = Object.keys(KIND_STYLE) as NodeKind[];

export type StateStyle = { label: string; accent: Accent; pulse: boolean; showsReason: boolean };

/** Each step state in words and colour. A reason line is shown for the three states that can say why they stopped. */
export const STATE_STYLE: Record<NodeState, StateStyle> = {
  planned: { label: "Planned", accent: "muted", pulse: false, showsReason: false },
  running: { label: "Running", accent: "info", pulse: true, showsReason: false },
  done: { label: "Done", accent: "success", pulse: false, showsReason: false },
  cache_hit: { label: "Reused", accent: "success", pulse: false, showsReason: false },
  skipped: { label: "Skipped", accent: "muted", pulse: false, showsReason: false },
  failed: { label: "Failed", accent: "danger", pulse: false, showsReason: true },
  // "NOT CONNECTED" is the literal word. A step with no handler did not run and has no output.
  not_connected: { label: "NOT CONNECTED", accent: "warning", pulse: false, showsReason: true },
  paused: { label: "Paused at budget", accent: "warning", pulse: false, showsReason: true },
  // Accepted by the provider and not finished: its poll settles it later. The reason says the step is queued and how to pick it up.
  queued: { label: "Queued at the provider", accent: "info", pulse: false, showsReason: true },
};

/** A step an edit would run again. It shows this instead of its last state. */
export const STALE_STYLE: StateStyle = { label: "To re-run", accent: "warning", pulse: false, showsReason: false };

const usd = (value: number): string => `$${value.toFixed(4)}`;

/** The cost a step shows: its recorded cost once it has one, otherwise the plan's estimate marked as an estimate, otherwise nothing. */
export function costText(costUsd: number | null | undefined, estimateUsd: number | null): string | null {
  if (costUsd !== null && costUsd !== undefined) return usd(costUsd);
  if (estimateUsd !== null) return `est. ${usd(estimateUsd)}`;
  return null;
}

/** The accessible name of a step: its kind, title, state, model and cost, in that order, so a screen reader hears the whole card. */
export function stepName(input: { kind: NodeKind; title: string; state: NodeState; stale: boolean; model: string | null; cost: string | null }): string {
  const parts = [`${KIND_STYLE[input.kind].label}: ${input.title}`, input.stale ? STALE_STYLE.label : STATE_STYLE[input.state].label];
  if (input.model !== null) parts.push(`model ${input.model}`);
  if (input.cost !== null) parts.push(input.cost);
  return parts.join(", ");
}

/** An edge takes the colour of the step it leaves. */
export function edgeAccent(from: NodeKind): Accent {
  return KIND_STYLE[from].accent;
}

/** The status shown beside the canvas: the replay position, or that the whole plan is shown. */
export function replayStatus(shown: number, total: number, showAll: boolean): string {
  if (showAll) return "Every step shown";
  return `${Math.min(shown, total)} of ${total} events drawn`;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5] as const;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 1.5;
const EPSILON = 1e-9;

/** The scale that fits a canvas `width` pixels wide into `available`: at most 1, and at least ZOOM_MIN (below that it scrolls). */
export function fitScale(available: number, width: number): number {
  if (!(available > 0) || !(width > 0)) return 1;
  return Math.min(1, Math.max(ZOOM_MIN, available / width));
}

/** The next zoom step from the current scale. At either end it stays where it is. */
export function nextZoom(current: number, direction: "in" | "out"): number {
  if (direction === "in") return ZOOM_STEPS.find((step) => step > current + EPSILON) ?? ZOOM_MAX;
  const below = ZOOM_STEPS.filter((step) => step < current - EPSILON);
  return below.length > 0 ? below[below.length - 1] : ZOOM_MIN;
}

export const BUDGET = { min: 0.01, max: 1000 } as const;

/** The longest text each field takes. The server checks the same limits; the form stops the typing at them. */
export const COMPOSER_LIMITS = { title: 120, goal: 2000, format: 4000, userInputs: 4000, brandSummary: 2000 } as const;

/** Goals a person can start from. They fill the goal field only; the person edits them before planning. */
export const EXAMPLE_GOALS = [
  "A 30-second product video built from our brand photos",
  "Rebuild a viral reference as an on-brand version",
  "A presenter explains one offer in 20 seconds",
  "Three short ads for one product, each with a different hook",
] as const;

/** The budget as a number, or null when it is blank, not a number, or outside the range the server accepts. */
export function parseBudget(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= BUDGET.min && parsed <= BUDGET.max ? parsed : null;
}

export type ComposerFields = { brandId: string; title: string; goal: string; format: string; budget: string; storedModel: string | null };

/** What the composer still needs before "Plan the run" can act, in the order the form asks for it. An empty list means it is ready. */
export function missingFields(fields: ComposerFields): string[] {
  const missing: string[] = [];
  if (fields.brandId === "") missing.push("a brand");
  if (fields.title.trim() === "") missing.push("a title");
  if (fields.goal.trim() === "") missing.push("a goal");
  if (fields.format.trim() === "") missing.push("the format");
  if (parseBudget(fields.budget) === null) missing.push("a budget from $0.01 to $1,000");
  if (fields.storedModel === null) missing.push("an orchestrating model, stored in the Content Factory panel");
  return missing;
}

/** Items as a sentence: "a", "a and b", "a, b and c". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A planning outcome as the server returns it. `status` is always there; `reason` or `reasons` come with the outcomes that carry them. */
export type PlanOutcome = { status: string; reason?: string; reasons?: string[] };

export type Notice = { tone: "success" | "warning" | "danger"; text: string };

/**
 * Why a plan cannot be drawn: a step reads a step that is not in the plan, or the steps depend on each other in a loop. Pure. The engine's
 * topological order is null in exactly these two cases, so one of them is always the reason.
 */
export function undrawnReason(nodes: ReadonlyArray<{ id: string; dependsOn: readonly string[] }>): string {
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const missing = node.dependsOn.find((dep) => !ids.has(dep));
    if (missing !== undefined) return `step ${node.id} reads step ${missing}, which is not in the plan.`;
  }
  return "the steps depend on each other in a loop, so there is no order to draw them in.";
}

/** The text as one sentence: a full stop is added unless the text already ends one. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The outcome of planning a draft, in words. Nothing is reported as planned unless the server said it was. */
export function describePlanOutcome(outcome: PlanOutcome): Notice {
  const reasons = (outcome.reasons ?? []).map((reason) => reason.trim()).filter((reason) => reason !== "");
  const because = sentence(listWords(reasons.length > 0 ? reasons : ["no reason was given"]));
  const reason = sentence(outcome.reason?.trim() ? outcome.reason.trim() : "No reason was given");
  switch (outcome.status) {
    case "ready":
      return { tone: "success", text: "The plan is ready. Review its steps, then run it." };
    case "refused":
      return { tone: "danger", text: `The plan was refused: ${because} It is kept in your plans.` };
    case "not_planned":
      return { tone: "warning", text: `The plan was not written: ${because} The draft is kept in your plans.` };
    case "not_connected":
      return { tone: "warning", text: `NOT CONNECTED. ${reason} The draft is kept in your plans.` };
    // A failed status is a read that failed, not a connection that is missing: the catalog was not read, so nothing was planned.
    case "failed":
      return { tone: "danger", text: `The catalog could not be read: ${reason} The draft is kept in your plans.` };
    default:
      return { tone: "danger", text: "The plan outcome was not recognised. Nothing was planned." };
  }
}
