// The pure model behind the mixed-plan prototype. No DOM, no network. The sample plan is illustrative: no provider was called, and its
// costs and models are placeholders chosen to show every state. scripts/design-prototype-model.test.mjs checks the geometry and the copy against the source
// files they come from, so this model cannot drift from the engine's layout or the app's state words without a failing test.

/** Canvas geometry. Mirrors src/engine/orchestrator/layout.ts; scripts/design-prototype-model.test.mjs reads that file and fails if the numbers differ. */
export const GEOMETRY = Object.freeze({ nodeWidth: 232, nodeHeight: 132, columnGap: 96, rowGap: 28, canvasPad: 40 });

/** The ten step kinds, with the labels the app shows (src/components/content-factory/orchestrator-presentation.ts). */
export const KIND_LABEL = Object.freeze({
  reference: "Reference", analysis: "Analysis", script: "Script", visual: "Still", video: "Shot",
  voice: "Voice", avatar: "Presenter", edit: "Edit", compose: "Compose", render: "Render",
});

/**
 * The ten step states. Each has a word, a dot shape and a tone, so no state is carried by colour alone (Katana section j).
 * Words match the app's labels; the drift test reads orchestrator-presentation.ts. "NOT CONNECTED" stays in capitals because the
 * engine writes it that way, so it cannot be missed.
 */
export const STATE = Object.freeze({
  planned: { label: "Planned", dot: "hollow", tone: "muted", reason: false },
  running: { label: "Running", dot: "filled", tone: "accent", reason: false },
  done: { label: "Done", dot: "filled", tone: "success", reason: false },
  cache_hit: { label: "Reused", dot: "hollow", tone: "success", reason: false },
  skipped: { label: "Skipped", dot: "hollow", tone: "muted", reason: true },
  failed: { label: "Failed", dot: "cross", tone: "danger", reason: true },
  not_connected: { label: "NOT CONNECTED", dot: "plug", tone: "warning", reason: true },
  paused: { label: "Paused at budget", dot: "pause", tone: "warning", reason: true },
  queued: { label: "Queued at the provider", dot: "hollow", tone: "info", reason: true },
  stale: { label: "To re-run", dot: "dashed", tone: "secondary", reason: false },
});

/** Filters for the plan. "Needs you" holds every state that waits on the person; the filter is visible and has a reset. */
export const FILTERS = Object.freeze({
  all: { label: "All steps", includes: () => true },
  needs: { label: "Needs you", includes: (step) => ["paused", "not_connected", "failed", "stale"].includes(step.state) },
  running: { label: "Running", includes: (step) => step.state === "running" },
});

/** Toast policy (Katana section h, Onlab's temporal hierarchy): passing confirmations leave by themselves, warnings and failures stay. */
export function toastDuration(kind) {
  if (kind === "success" || kind === "info") return 4000;
  if (kind === "warning" || kind === "danger") return null;
  throw new Error(`no toast policy for ${kind}`);
}

/**
 * The cost a step shows. A recorded value is shown as recorded, including zero. An estimate starts with "est.". A step that makes no
 * model call says so. A missing figure reads "not recorded". It is never 0 and never blank (Katana principle 4).
 */
export function costLabel(cost) {
  if (cost.kind === "none") return "No model call";
  if (cost.kind === "recorded") return `$${cost.usd.toFixed(4)}`;
  if (cost.kind === "estimate") return cost.usd === null ? "not recorded" : `est. $${cost.usd.toFixed(4)}`;
  if (cost.kind === "unknown") return "not recorded";
  throw new Error(`no cost rule for ${cost.kind}`);
}

/** The example goals the brief offers. They fill the goal field only. Copied from the app; scripts/design-prototype-model.test.mjs checks them against the source. */
export const EXAMPLE_GOALS = Object.freeze([
  "A 30-second product video built from our brand photos",
  "Rebuild a viral reference as an on-brand version",
  "A presenter explains one offer in 20 seconds",
  "Three short ads for one product, each with a different hook",
]);

/** A sample plan for the first example goal in the app. Every state appears once; costs and models are placeholders. */
export const SAMPLE_PLAN = Object.freeze({
  title: "A 30-second product video built from our brand photos",
  steps: [
    { id: "s1", kind: "reference", title: "Brand photo set", reads: [], state: "done", model: null, cost: { kind: "none" } },
    { id: "s2", kind: "analysis", title: "Read the brand photos", reads: ["s1"], state: "done", model: "text model", cost: { kind: "recorded", usd: 0.0212 } },
    { id: "s3", kind: "script", title: "Write 30 seconds of lines", reads: ["s2"], state: "done", model: "text model", cost: { kind: "recorded", usd: 0.0141 } },
    { id: "s4", kind: "visual", title: "The product in use", reads: ["s3"], state: "running", model: "image model", cost: { kind: "estimate", usd: 0.09 } },
    { id: "s5", kind: "voice", title: "Voice-over", reads: ["s3"], state: "paused", model: "speech model", cost: { kind: "estimate", usd: 0.08 } },
    { id: "s6", kind: "video", title: "Three cuts of the product", reads: ["s3", "s4"], state: "not_connected", model: "video model", cost: { kind: "estimate", usd: 0.18 } },
    { id: "s7", kind: "edit", title: "Cut and time", reads: ["s5", "s6"], state: "planned", model: null, cost: { kind: "none" } },
    { id: "s8", kind: "render", title: "Render 9:16 MP4", reads: ["s7"], state: "planned", model: null, cost: { kind: "none" } },
  ],
});

/** Where the state's reason sits. Only states that carry a reason show one. Each reason names the next step, in words. */
export const REASON = Object.freeze({
  paused: "The copy budget is spent for this run. Raise it in Settings to continue.",
  not_connected: "No video provider is connected. Connect one in Settings to run this step.",
});

/**
 * Places each step on the canvas. Its column is one more than the largest column of the steps it reads; steps that share a column
 * stack in plan order. Horizontal is the reading relation (what a step reads, and what reads it). Vertical is "runs alongside".
 */
export function layoutSteps(steps, geometry = GEOMETRY) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const column = new Map();
  const visit = (id, stack = []) => {
    if (column.has(id)) return column.get(id);
    if (stack.includes(id)) throw new Error(`cycle through ${id}`);
    const step = byId.get(id);
    if (!step) throw new Error(`no step ${id}`);
    const reads = step.reads.map((dep) => visit(dep, [...stack, id]));
    const value = reads.length === 0 ? 0 : Math.max(...reads) + 1;
    column.set(id, value);
    return value;
  };
  for (const step of steps) visit(step.id);

  const rowInColumn = new Map();
  const nodes = steps.map((step) => {
    const col = column.get(step.id);
    const row = rowInColumn.get(col) ?? 0;
    rowInColumn.set(col, row + 1);
    return {
      id: step.id,
      column: col,
      row,
      x: geometry.canvasPad + col * (geometry.nodeWidth + geometry.columnGap),
      y: geometry.canvasPad + row * (geometry.nodeHeight + geometry.rowGap),
    };
  });
  const edges = steps.flatMap((step) => step.reads.map((from) => ({ from, to: step.id })));
  const columns = Math.max(...column.values()) + 1;
  const tallest = Math.max(...rowInColumn.values());
  return {
    nodes,
    edges,
    width: geometry.canvasPad * 2 + columns * geometry.nodeWidth + (columns - 1) * geometry.columnGap,
    height: geometry.canvasPad * 2 + tallest * geometry.nodeHeight + (tallest - 1) * geometry.rowGap,
  };
}

/** The ids the current filter shows, in plan order. */
export function visibleIds(state, plan = SAMPLE_PLAN) {
  return plan.steps.filter((step) => FILTERS[state.filter].includes(step)).map((step) => step.id);
}

/** The starting state of the prototype. Nothing is selected, the canvas shows, and no filter is set. */
export function initialState() {
  return { view: "canvas", selectedId: null, drawerOpen: false, filter: "all", assistantOpen: false, loading: false, toasts: [], notice: null };
}

/**
 * The one state transition the prototype makes. Identity rules, which the tests check:
 * - the selected step survives every change of view, a close, and the assistant opening or closing;
 * - selecting a step the filter hides never fails silently: the filter is cleared and a notice says so.
 */
export function reduce(state, action, plan = SAMPLE_PLAN) {
  switch (action.type) {
    case "view":
      return { ...state, view: action.view };
    case "select": {
      const known = plan.steps.some((step) => step.id === action.id);
      if (!known) throw new Error(`no step ${action.id}`);
      if (visibleIds(state, plan).includes(action.id)) {
        return { ...state, selectedId: action.id, drawerOpen: true, notice: null };
      }
      return {
        ...state,
        filter: "all",
        selectedId: action.id,
        drawerOpen: true,
        notice: `That step was hidden by the filter "${FILTERS[state.filter].label}". Showing all steps.`,
      };
    }
    case "close":
      return { ...state, drawerOpen: false };
    case "filter":
      return { ...state, filter: action.filter, notice: null };
    case "assistant":
      return { ...state, assistantOpen: action.open };
    case "loading":
      return { ...state, loading: action.on };
    case "toast":
      return { ...state, toasts: [...state.toasts, { id: action.id, kind: action.kind, text: action.text }] };
    case "dismiss":
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
    default:
      throw new Error(`unknown action ${action.type}`);
  }
}

/** Words for the filter bar. Shown in text, never only as a count or a colour. */
export function restrictionText(state, plan = SAMPLE_PLAN) {
  if (state.filter === "all") return `${plan.steps.length} steps`;
  const shown = visibleIds(state, plan).length;
  return `Showing ${shown} of ${plan.steps.length} steps: ${FILTERS[state.filter].label.toLowerCase()}.`;
}

/**
 * What each state means and what the person does next. Plain sentences, each one a full claim. The plates on the page render these,
 * and scripts/design-prototype-model.test.mjs checks that every state has both.
 */
export const STATE_COPY = Object.freeze({
  planned: { meaning: "Waiting for the steps it reads. It runs once they are done.", next: "Nothing to do yet." },
  running: { meaning: "The model is working on it now.", next: "Changes wait until it finishes." },
  done: { meaning: "Finished. The result is kept and its cost is recorded.", next: "Nothing to do." },
  cache_hit: { meaning: "A matching result already exists, so nothing new was made or paid for.", next: "Nothing to do." },
  skipped: { meaning: "The plan does not need it for this brief.", next: "Change the plan if you want it to run." },
  failed: { meaning: "It ran and did not succeed. The reason is kept with the step.", next: "Read the reason, then run the step again." },
  not_connected: { meaning: "The provider it needs is not connected, so it did not run.", next: "Connect the provider in Settings." },
  paused: { meaning: "The budget for this run is used up, so the run stopped here.", next: "Raise the budget in Settings to continue." },
  queued: { meaning: "The provider accepted the job and has not finished it yet.", next: "Check again later. Nothing is needed from you." },
  stale: { meaning: "A step it reads has changed, so this result is out of date.", next: "Run the step again." },
});

/** What each kind of cost figure says about itself. The figures themselves come from costLabel. */
export const COST_COPY = Object.freeze({
  recorded: "The amount the provider charged for this step.",
  estimate: "The planned amount, before the step runs. Nothing is paid yet.",
  unknown: "No amount is known. It is never shown as zero.",
  none: "The step calls no model, so it has no model cost.",
});
