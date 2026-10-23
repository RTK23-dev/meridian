// The view rules of the orchestrator's canvas and its starting screen: what each step kind looks like, what each state means, how a cost
// and a zoom are shown, what the composer needs before it can plan, and how a planning outcome is said. Pure and browser-safe (no React,
// no node:* imports), so the rules are tested here and the components only draw them. Nothing in this file names a model.

import type { NodeKind, NodeState } from "../../engine/orchestrator/contracts.ts";
// The category list is the engine's, read from a module that is free of Node-only imports, so the screen and the engine name the same lines.
import { BUDGET_CATEGORIES, type BudgetCategory } from "../../engine/orchestrator/categories.ts";
// The engine's reason for an unreadable policy row. The policy read and the saves refuse with it, so the screen matches the same text.
import { UNREADABLE_POLICY_REASON } from "../../engine/orchestrator/policy-store.ts";

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
  return parseAmount(value, BUDGET.min, BUDGET.max);
}

/** A typed number from `min` to `max`, or null when it is blank, not a number, or outside the range. */
function parseAmount(value: string, min: number, max: number): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** A brief from a format to copy or make, or from the person's own inputs. The mode says which of the two is required. */
export type ComposerMode = "format" | "own";

export type ComposerFields = {
  brandId: string;
  title: string;
  goal: string;
  format: string;
  budget: string;
  storedModel: string | null;
  /** Defaults to a format to copy or make. */
  mode?: ComposerMode;
  userInputs?: string;
  /** The optional budgets by category, as typed. Empty is unset: the orchestrator splits that category under the total. */
  copyBudget?: string;
  creativeBudget?: string;
  voiceBudget?: string;
};

/** A category budget as the composer sends it: unset when empty, otherwise the budget in the same range as the total. */
export function optionalBudget(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return parseBudget(value) ?? undefined;
}

/** What the composer still needs before "Plan the run" can act, in the order the form asks for it. An empty list means it is ready. */
export function missingFields(fields: ComposerFields): string[] {
  const missing: string[] = [];
  if (fields.brandId === "") missing.push("a brand");
  if (fields.title.trim() === "") missing.push("a title");
  if (fields.goal.trim() === "") missing.push("a goal");
  // A format is required when the person copies one. With their own inputs, the inputs are required instead.
  if (fields.mode === "own") {
    if ((fields.userInputs ?? "").trim() === "") missing.push("your inputs");
  } else if (fields.format.trim() === "") {
    missing.push("the format");
  }
  if (parseBudget(fields.budget) === null) missing.push("a budget from $0.01 to $1,000");
  const categories = [
    ["copy", fields.copyBudget],
    ["creative", fields.creativeBudget],
    ["voice", fields.voiceBudget],
  ] as const;
  for (const [name, value] of categories) {
    if (value !== undefined && value.trim() !== "" && parseBudget(value) === null) missing.push(`a ${name} budget from $0.01 to $1,000, or left empty`);
  }
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

// The budget line, the approvals, the measured average and the model policy (owner direction 2026-10-23: decisions D12 to D17).

const unique = (items: readonly string[]): string[] => [...new Set(items)];

/** A dollar amount with a fixed number of places, as the screens show budgets and costs. */
const dollars = (value: number, places: number): string => `$${value.toFixed(places)}`;

/** The measure ceiling's range, in USD per second. The server checks the same range (policy-store.ts). */
export const CEILING = { min: 0.01, max: 5 } as const;

/** The measure ceiling as a number, or null when it is blank, not a number, or outside the range. */
export function parseCeiling(value: string): number | null {
  return parseAmount(value, CEILING.min, CEILING.max);
}

/** The ceiling in words: "$0.50 per second". */
export function ceilingText(usdPerSecond: number): string {
  return `${dollars(usdPerSecond, 2)} per second`;
}

/** A budget line a pause can stop at: the total (no category) or one of the category lines (copy, creative or voice). */
export type PauseCategory = BudgetCategory;

/** The heading of the alert for a plan paused at the total budget line. Every viewer sees it; only an admin gets the approval control. */
export const BUDGET_PAUSE_HEADING = "Budget reached, project not finished";

/** The opening of a pause reason: the category, when the line is a category's, then the phrase the run writes (execute.ts). */
const PAUSE_OPENING = new RegExp(`^(?:(${BUDGET_CATEGORIES.join("|")}) )?budget reached, project not finished`, "i");

/**
 * The category a pause stopped at, read from the pause event's reason. The event carries no category field, so the run's own opening words are
 * the source. Null for the total line, and for a reason that names no category. Pure.
 */
export function pauseCategoryOf(reason: string | null | undefined): PauseCategory | null {
  const match = PAUSE_OPENING.exec((reason ?? "").trim());
  return match?.[1] === undefined ? null : (match[1].toLowerCase() as PauseCategory);
}

/** Which line a pause stopped at: the total budget, the workspace month, or one category's line. */
export type PauseLine = "total" | "month" | PauseCategory;

/** What the alert says for a pause at the workspace month. The month is set in settings, so no approval of the plan clears it. */
export const MONTH_PAUSE_SENTENCE = "The workspace month is at its budget; raise the monthly budget in settings.";

/**
 * The line a pause stopped at, read from the pause event's reason, which carries no line field of its own. A month refusal names the workspace
 * month in its words (budget/reserve.ts), so the month is read first: no approval of the plan clears it. Then a category's opening, and otherwise
 * the total. Pure.
 */
export function pauseLineOf(reason: string | null | undefined): PauseLine {
  if (/workspace month/i.test(reason ?? "")) return "month";
  return pauseCategoryOf(reason) ?? "total";
}

/** The heading of the alert for a pause: the total's or the month's, or a category's named the way the run names it ("Copy budget reached, ..."). */
export function budgetPauseHeading(line: PauseLine): string {
  if (line === "total" || line === "month") return BUDGET_PAUSE_HEADING;
  return `${line.charAt(0).toUpperCase()}${line.slice(1)} budget reached, project not finished`;
}

/**
 * The pause reason under the alert heading. The run's own words are kept, and the opening the heading already says (the total line's, or a
 * category's) is taken off the front, so it is not said twice. A missing reason is said to be missing, never shown as a guess. Pure.
 */
export function budgetPauseDetail(reason: string | null | undefined): string {
  const text = (reason ?? "").trim();
  if (text === "") return "No reason was recorded for this pause.";
  const match = PAUSE_OPENING.exec(text);
  if (match === null) return text;
  const rest = text.slice(match[0].length).replace(/^[\s:]+/, "");
  if (rest === "") return "The run stopped at its budget line.";
  return `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

/** One recorded budget approval, as the plan's list shows it. */
export type ApprovalRow = { id: string; actorId: string; previousUsd: number; approvedUsd: number; createdAt: string };

/** The time an approval was made, for ordering. A time that cannot be read sorts as the oldest, so it never moves a row up. */
function approvalTime(row: { createdAt: string }): number {
  const time = Date.parse(row.createdAt);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/** The approvals newest first. Two at the same time keep the larger id first. The list passed is not changed. Pure. */
export function approvalsNewestFirst<T extends { id: string; createdAt: string }>(approvals: readonly T[]): T[] {
  return [...approvals].sort((a, b) => {
    const byTime = approvalTime(b) - approvalTime(a);
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** The name a row shows for who approved: the member's name, else the email, else a plain note when that person is no longer a member. Pure. */
export function actorNameOf(actorId: string, members: ReadonlyArray<{ userId: string; name: string; email: string }>): string {
  const member = members.find((candidate) => candidate.userId === actorId);
  if (member === undefined) return "A member no longer in this workspace";
  return member.name.trim() || member.email.trim() || "A workspace member";
}

/** The line an approval raised, from the reason its audit row carries ("category copy; ..."). Null for a total approval. Pure. */
export function approvalCategoryOf(reason: string | null | undefined): PauseCategory | null {
  const match = new RegExp(`^category (${BUDGET_CATEGORIES.join("|")});`).exec(reason ?? "");
  return match === null ? null : (match[1] as PauseCategory);
}

/**
 * One approval in words: who approved it, the approved budget, and the budget it came from. A category's approval names the category, and its
 * amounts are that category's line. A total approval names no category.
 */
export function approvalText(row: { actor: string; previousUsd: number; approvedUsd: number; category?: PauseCategory | null }): string {
  if (row.category) return `${row.actor} approved the ${row.category} budget at ${dollars(row.approvedUsd, 2)}, from ${dollars(row.previousUsd, 2)}.`;
  return `${row.actor} approved ${dollars(row.approvedUsd, 2)}, from a budget of ${dollars(row.previousUsd, 2)}.`;
}

/** The text of an error, in whichever form it arrives. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

/** Whether a policy read or save was refused because the stored row cannot be read (policy-store.ts). Pure. */
export function isUnreadablePolicyError(error: unknown): boolean {
  return messageOf(error).includes(UNREADABLE_POLICY_REASON);
}

/** The unreadable-policy reason as the screen says it: a sentence, with its full stop. */
export const UNREADABLE_POLICY_SENTENCE = `${UNREADABLE_POLICY_REASON.charAt(0).toUpperCase()}${UNREADABLE_POLICY_REASON.slice(1)}.`;

/**
 * The line under the approval amount: what the amount does, or what it must be. The total line's amount must be above the plan's budget. A
 * category's line is not on the screen, so the server checks that amount, and the line says what it must be above. Pure.
 */
export function approvalHint(input: { category: PauseCategory | null; budgetUsd: number; amount: number | null }): string {
  const { category, budgetUsd, amount } = input;
  if (category === null) {
    if (amount !== null && amount > budgetUsd) return `Approving ${dollars(amount, 2)} raises the budget from ${dollars(budgetUsd, 2)}.`;
    return `The run stops at the budget line of ${dollars(budgetUsd, 2)}. The approved budget must be above it.`;
  }
  if (amount === null) return `Enter the amount the ${category} budget should be raised to.`;
  return `Approving ${dollars(amount, 2)} raises the ${category} budget. The amount must be above the ${category} budget the plan has now.`;
}

/**
 * The measured average (D15): the reported cost per second over the workspace's clips, or that no clip has been measured. It is shown as a
 * measurement and never as a prediction, and it never sets a hold. A missing average or a clip count below one reads as not measured.
 */
export function measuredAverageText(measured: { measuredAverageUsdPerSecond: number | null; clips: number }): string {
  const { measuredAverageUsdPerSecond: average, clips } = measured;
  if (average === null || !Number.isFinite(average) || !(clips >= 1)) return "no clip measured yet";
  return `measured average: ${dollars(average, 4)} per second over ${clips} ${clips === 1 ? "clip" : "clips"}`;
}

/** A model family as the policy stores it: lowercase, with no leading ~, which marks a live alias. Pure. */
export function normalizeFamily(text: string): string {
  return text.trim().replace(/^~/, "").toLowerCase();
}

/** The families typed in a comma-separated box: each normalized, with the empty and the repeated ones dropped, in the order typed. Pure. */
export function familiesFromText(text: string): string[] {
  const families: string[] = [];
  for (const part of text.split(",")) {
    const family = normalizeFamily(part);
    if (family !== "" && !families.includes(family)) families.push(family);
  }
  return families;
}

/** A list of families with one family switched on or off. The order is kept and nothing repeats. Pure. */
export function withFamily(families: readonly string[], family: string, on: boolean): string[] {
  if (!on) return families.filter((existing) => existing !== family);
  return families.includes(family) ? [...families] : [...families, family];
}

/** One row of a family list: the family, whether it is switched off, whether a brand may not change it, and whether it is off by default. */
export type FamilyRow = { family: string; switchedOff: boolean; locked: boolean; offByDefault: boolean };

/**
 * The rows of the workspace's list. The families off by default come first, so each one shows even when it is switched on; then the other
 * families the workspace switches off. A row is switched off when the workspace's list holds it. Pure.
 */
export function workspaceFamilyRows(input: { defaults: readonly string[]; switchedOff: readonly string[] }): FamilyRow[] {
  return unique([...input.defaults, ...input.switchedOff]).map((family) => ({
    family,
    switchedOff: input.switchedOff.includes(family),
    locked: false,
    offByDefault: input.defaults.includes(family),
  }));
}

/**
 * The rows of a brand's list: the families the workspace switches off, locked on for the brand, then the brand's own families. A family in
 * both lists shows once, as locked. Pure.
 */
export function brandFamilyRows(input: { workspaceFamilies: readonly string[]; brandFamilies: readonly string[] }): FamilyRow[] {
  const locked = unique(input.workspaceFamilies);
  const own = unique(input.brandFamilies).filter((family) => !locked.includes(family));
  return [
    ...locked.map((family) => ({ family, switchedOff: true, locked: true, offByDefault: false })),
    ...own.map((family) => ({ family, switchedOff: true, locked: false, offByDefault: false })),
  ];
}

/**
 * A brand's own list with one family switched on or off for that brand. A family the workspace switches off is locked on for the brand: the
 * list comes back unchanged, so no brand can switch it on. Pure.
 */
export function brandFamiliesAfter(brandFamilies: readonly string[], workspaceFamilies: readonly string[], family: string, on: boolean): string[] {
  if (workspaceFamilies.includes(family)) return [...brandFamilies];
  return withFamily(brandFamilies, family, on);
}
