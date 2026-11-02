// The prototype's view controller. It holds no plan logic of its own: every change goes through reduce() in model.mjs, and every
// piece of text comes from the model. Text is escaped before it reaches the page.
import {
  EXAMPLE_GOALS, KIND_LABEL, KIND_SHIPPED_ACCENT, REASON, SAMPLE_PLAN, STATE, costLabel, initialState, layoutSteps, reduce,
  restrictionText, toastDuration, visibleIds,
} from "./model.mjs";

const plan = SAMPLE_PLAN;
const layout = layoutSteps(plan.steps);
const byId = new Map(plan.steps.map((step) => [step.id, step]));
const placed = new Map(layout.nodes.map((node) => [node.id, node]));
/** Reading order: column by column, top to bottom. Tab order, the strip and the list all follow it. */
const reading = [...layout.nodes].sort((a, b) => a.column - b.column || a.row - b.row).map((node) => node.id);
const number = new Map(reading.map((id, index) => [id, index + 1]));
const NEEDS = new Set(["paused", "not_connected", "failed", "stale"]);
const ZOOMS = [0.5, 0.75, 1];

let state = initialState();
let zoom = 0.75;
let freshNext = true;
let toastSeq = 0;
const timers = new Map();
const phoneQuery = matchMedia("(max-width: 639px)");

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const dispatch = (action) => {
  state = reduce(state, action, plan);
  render();
};

/** On a phone the canvas is replaced by the step list: the same steps, in the same order, in a unit that fits the width. */
const effectiveView = () => (phoneQuery.matches && state.view === "canvas" ? "list" : state.view);

const dot = (tone, shape) => `<span class="dot dot-${shape}" aria-hidden="true"></span>`;
const stateWord = (key) => {
  const s = STATE[key];
  return `<span class="state-word" data-tone="${s.tone}">${dot(s.tone, s.dot)}${esc(s.label)}</span>`;
};
const cost = (step) => costLabel(step.cost);
const isMissing = (step) => cost(step) === "not recorded" || cost(step) === "No model call";
const modelText = (step) => step.model ?? "No model call";
const readsText = (step) => (step.reads.length === 0 ? "Reads nothing. It starts the plan." : `Reads: ${step.reads.map((id) => byId.get(id).title).join(", ")}`);
/** The cost as a screen reader says it: "estimated" or "recorded", then the amount (Katana section j). */
const spoken = (text) => (text.startsWith("est. ") ? `estimated ${text.slice(5)}` : text.startsWith("$") ? `recorded ${text}` : text);
const accessibleName = (step) =>
  `Step ${number.get(step.id)} of ${plan.steps.length}. ${KIND_LABEL[step.kind]}: ${step.title}. ${STATE[step.state].label}. ${modelText(step)}. ${spoken(cost(step))}.`;

function nodeMarkup(step, { mode, selected, dimmed }) {
  const node = placed.get(step.id);
  const classes = ["node", `is-${step.state}`];
  if (NEEDS.has(step.state)) classes.push("is-needs");
  if (step.state === "not_connected") classes.push("is-blocked");
  if (step.state === "failed") classes.push("is-failed");
  if (step.state === "stale") classes.push("is-stale");
  if (dimmed) classes.push("is-dimmed");
  const current = selected ? ' aria-current="true"' : "";
  const style = mode === "canvas" ? ` style="left:${node.x}px;top:${node.y}px"` : "";
  const foot = `<span class="node-foot${isMissing(step) ? " is-missing" : ""}">${esc(cost(step))}</span>`;
  return `<button type="button" class="${classes.join(" ")}" data-id="${step.id}" data-accent="${KIND_SHIPPED_ACCENT[step.kind]}" aria-label="${esc(accessibleName(step))}"${current}${style}>
    <span class="node-head"><span class="kind">${esc(KIND_LABEL[step.kind])}</span>${stateWord(step.state)}</span>
    <span class="title">${esc(step.title)}</span>
    <span class="model">${esc(modelText(step))}</span>
    ${foot}
  </button>`;
}

function skeletonMarkup(step) {
  const node = placed.get(step.id);
  return `<div class="node is-skeleton" aria-hidden="true" style="left:${node.x}px;top:${node.y}px">
    <span class="bar"></span><span class="bar short"></span><span class="bar"></span></div>`;
}

function canvasView(ids) {
  const nodes = reading.map((id) => byId.get(id));
  const edges = layout.edges.map(({ from, to }) => {
    const a = placed.get(from);
    const b = placed.get(to);
    const x1 = a.x + 232;
    const y1 = a.y + 66;
    const x2 = b.x;
    const y2 = b.y + 66;
    const bend = 48;
    const target = byId.get(to).state;
    const cls = target === "running" ? "edge-running" : ["done", "cache_hit"].includes(target) ? "edge-done" : target === "failed" ? "edge-failed" : "";
    return `<path pathLength="1" class="${cls}" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}"/>`;
  });
  const selectedId = state.selectedId;
  const body = nodes.map((step) => {
    if (state.loading) return skeletonMarkup(step);
    return nodeMarkup(step, { mode: "canvas", selected: step.id === selectedId, dimmed: !ids.includes(step.id) });
  });
  return `<div class="canvas" style="width:${layout.width}px;height:${layout.height}px" aria-busy="${state.loading}">
    <svg class="edges" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">${edges.join("")}</svg>
    ${body.join("")}
  </div>`;
}

function stripView(ids) {
  const cards = reading.map((id) => byId.get(id)).filter((step) => ids.includes(step.id));
  return `<div class="strip" role="group" aria-label="Steps, in reading order">${cards.map((step) => `
    <button type="button" class="strip-card is-${step.state}" data-id="${step.id}" data-accent="${KIND_SHIPPED_ACCENT[step.kind]}" aria-label="${esc(accessibleName(step))}"${step.id === state.selectedId ? ' aria-current="true"' : ""} style="position:relative">
      <span class="strip-head"><span class="kind">${esc(KIND_LABEL[step.kind])}</span>${stateWord(step.state)}</span>
      <span class="title">${esc(step.title)}</span>
      <span class="model">${esc(modelText(step))}</span>
      <span class="node-foot${isMissing(step) ? " is-missing" : ""}">${esc(cost(step))}</span>
    </button>`).join("")}</div>`;
}

function listView(ids) {
  const rows = reading.map((id) => byId.get(id)).filter((step) => ids.includes(step.id));
  const head = `<div class="index-head" aria-hidden="true"><span class="label">State</span><span class="label">Step</span><span class="label">Kind</span><span class="label">Model</span><span class="label" style="text-align:right">Cost</span><span class="label">Reads</span></div>`;
  const items = rows.map((step) => `
    <li data-id="${step.id}"${step.id === state.selectedId ? ' aria-current="true"' : ""}>
      ${stateWord(step.state)}
      <button type="button" class="step-btn" data-id="${step.id}" aria-label="${esc(accessibleName(step))}">${esc(step.title)}</button>
      <span class="cell-text kind-cell">${esc(KIND_LABEL[step.kind])}</span>
      <span class="cell-text mono model-cell">${esc(modelText(step))}</span>
      <span class="cell-mono cost-cell${isMissing(step) ? " is-missing" : ""}">${esc(cost(step))}</span>
      <span class="cell-text reads-cell">${esc(readsText(step))}</span>
    </li>`).join("");
  return `${head}<ul class="index" aria-label="Steps, in reading order">${items}</ul>`;
}

function renderPlan() {
  const view = effectiveView();
  const ids = visibleIds(state, plan);
  const frame = $("#frame");
  frame.classList.toggle("is-flow", view !== "canvas");
  frame.style.setProperty("--zoom", String(zoom));
  frame.classList.toggle("fresh", freshNext);
  frame.setAttribute("aria-busy", String(state.loading));
  frame.innerHTML = view === "canvas" ? canvasView(ids) : view === "strip" ? stripView(ids) : listView(ids);
  freshNext = false;

  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === view;
    button.setAttribute("aria-pressed", String(active));
    button.hidden = phoneQuery.matches && button.dataset.view === "canvas";
  }
  for (const button of document.querySelectorAll("[data-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === state.filter));
  }
  $("#zoom-level").textContent = `${Math.round(zoom * 100)}%`;
  $("#zoom-out").disabled = zoom <= ZOOMS[0];
  $("#zoom-in").disabled = zoom >= ZOOMS[ZOOMS.length - 1];
  $("#zoom-controls").hidden = view !== "canvas";
  $("#redraw").disabled = state.loading;

  const restriction = state.loading ? "Redrawing the plan. The steps keep their places." : restrictionText(state, plan);
  $("#restriction").innerHTML = `${esc(restriction)}${state.filter !== "all" ? ' <button type="button" class="btn btn-quiet" id="show-all">Show all steps</button>' : ""}`;

  const notice = $("#notice");
  notice.classList.toggle("is-empty", !state.notice);
  notice.textContent = state.notice ?? "";

  const needs = plan.steps.filter((step) => NEEDS.has(step.state));
  const resume = $("#resume");
  resume.disabled = needs.length > 0;
  $("#resume-reason").textContent = needs.length > 0
    ? `Resume is off. These steps need you first: ${needs.map((step) => step.title).join("; ")}.`
    : "";
  if (needs.length === 0) resume.removeAttribute("aria-describedby");
  else resume.setAttribute("aria-describedby", "resume-reason");

  renderDrawer();
}

/** The details overlay covers the right 480 px of the window. After a selection, scroll the canvas so the step is not under it. */
function keepClear(id) {
  if (!state.drawerOpen || effectiveView() !== "canvas" || phoneQuery.matches) return;
  const frame = $("#frame");
  const node = frame.querySelector(`.canvas [data-id="${id}"]`);
  if (!node) return;
  const overflow = node.getBoundingClientRect().right - (window.innerWidth - 480 - 16);
  if (overflow > 0) frame.scrollLeft += overflow;
}

function renderDrawer() {
  const drawer = $("#drawer");
  const step = state.selectedId ? byId.get(state.selectedId) : null;
  drawer.hidden = !(state.drawerOpen && step);
  if (!step || !state.drawerOpen) return;
  const readBy = plan.steps.filter((other) => other.reads.includes(step.id));
  const ref = (other) => `<button type="button" class="btn btn-secondary" data-select="${other.id}">${esc(other.title)}</button>`;
  $("#drawer-kind").textContent = `${KIND_LABEL[step.kind]} · step ${number.get(step.id)} of ${plan.steps.length}`;
  $("#drawer-body").innerHTML = `
    <div class="drawer-state">${stateWord(step.state)}</div>
    <h2 id="drawer-title" tabindex="-1">${esc(step.title)}</h2>
    <dl>
      <div><dt>Model</dt><dd class="${step.model ? "mono" : ""}">${esc(modelText(step))}</dd></div>
      <div><dt>Cost</dt><dd class="${isMissing(step) ? "" : "mono"}">${esc(cost(step))}</dd></div>
      <div><dt>Reads</dt><dd>${step.reads.length === 0 ? "Nothing. It starts the plan." : `<div class="ref-list">${step.reads.map((id) => ref(byId.get(id))).join("")}</div>`}</dd></div>
      <div><dt>Read by</dt><dd>${readBy.length === 0 ? "Nothing yet." : `<div class="ref-list">${readBy.map(ref).join("")}</div>`}</dd></div>
      ${REASON[step.state] ? `<div><dt>Why it stopped</dt><dd class="reason" data-tone="${STATE[step.state].tone}">${esc(REASON[step.state])}</dd></div>` : ""}
    </dl>`;
}

function renderSystemMenus() {
  for (const button of document.querySelectorAll("[data-set-system]")) {
    button.setAttribute("aria-checked", String(button.dataset.setSystem === document.documentElement.dataset.system));
  }
  // No explicit choice means the system setting decides, so the checked button is the theme the page is showing.
  const current = document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  for (const button of document.querySelectorAll("[data-set-theme]")) {
    button.setAttribute("aria-checked", String(button.dataset.setTheme === current));
  }
}

function renderAssistant() {
  const open = state.assistantOpen;
  $("#assistant").hidden = !open;
  $("#assistant-toggle").setAttribute("aria-expanded", String(open));
  $("#panel-brief").dataset.assistant = open ? "open" : "closed";
}

function renderToasts() {
  $("#toasts").innerHTML = state.toasts.map((toast) => `
    <div class="toast" role="status" data-kind="${toast.kind}" data-toast="${toast.id}" style="--tone:var(--${toast.kind === "success" ? "success" : toast.kind === "danger" ? "danger" : toast.kind === "warning" ? "warning" : "info"})">
      <span>${esc(toast.text)}</span>
      <button type="button" class="btn btn-quiet" data-dismiss="${toast.id}">Dismiss</button>
    </div>`).join("");
}

function render() {
  renderPlan();
  renderAssistant();
  renderSystemMenus();
  renderToasts();
}

function notify(kind, text) {
  toastSeq += 1;
  const id = `t${toastSeq}`;
  dispatch({ type: "toast", kind, text, id });
  const duration = toastDuration(kind);
  if (duration !== null) timers.set(id, setTimeout(() => dismiss(id), duration));
}

function dismiss(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  dispatch({ type: "dismiss", id });
}

function setTab(name, focus = false) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const panel of document.querySelectorAll('[role="tabpanel"]')) {
    panel.hidden = panel.dataset.screen !== name;
  }
}

function redraw() {
  dispatch({ type: "loading", on: true });
  freshNext = true;
  setTimeout(() => {
    freshNext = true;
    dispatch({ type: "loading", on: false });
  }, 900);
}

function bind() {
  // Places and the brand mark are shown, not routed: prevent the hash change.
  for (const link of document.querySelectorAll(".rail a")) {
    link.addEventListener("click", (event) => event.preventDefault());
  }
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener("click", () => setTab(tab.dataset.tab));
    tab.addEventListener("keydown", (event) => {
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      const index = tabs.indexOf(tab);
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        setTab(next.dataset.tab, true);
        event.preventDefault();
      }
    });
  }
  for (const button of document.querySelectorAll("[data-set-system]")) {
    button.addEventListener("click", () => {
      document.documentElement.dataset.system = button.dataset.setSystem;
      renderSystemMenus();
    });
  }
  for (const button of document.querySelectorAll("[data-set-theme]")) {
    button.addEventListener("click", () => {
      document.documentElement.dataset.theme = button.dataset.setTheme;
      renderSystemMenus();
    });
  }
  $("#greyscale").addEventListener("change", (event) => {
    document.documentElement.toggleAttribute("data-greyscale", event.target.checked);
  });
  for (const button of document.querySelectorAll("[data-view]")) {
    button.addEventListener("click", () => dispatch({ type: "view", view: button.dataset.view }));
  }
  for (const button of document.querySelectorAll("[data-filter]")) {
    button.addEventListener("click", () => dispatch({ type: "filter", filter: button.dataset.filter }));
  }
  $("#restriction").addEventListener("click", (event) => {
    if (event.target.id === "show-all") dispatch({ type: "filter", filter: "all" });
  });
  $("#zoom-in").addEventListener("click", () => { zoom = ZOOMS[Math.min(ZOOMS.indexOf(zoom) + 1, ZOOMS.length - 1)]; render(); });
  $("#zoom-out").addEventListener("click", () => { zoom = ZOOMS[Math.max(ZOOMS.indexOf(zoom) - 1, 0)]; render(); });
  $("#redraw").addEventListener("click", redraw);

  const frame = $("#frame");
  const select = (id) => {
    dispatch({ type: "select", id });
    requestAnimationFrame(() => {
      keepClear(id);
      document.getElementById("drawer-title")?.focus({ preventScroll: true });
    });
  };
  // With the canvas itself focused: arrows scroll it, plus and minus zoom, zero resets the zoom.
  frame.addEventListener("keydown", (event) => {
    if (event.target !== frame || effectiveView() !== "canvas") return;
    const step = 80;
    if (event.key === "ArrowRight") frame.scrollLeft += step;
    else if (event.key === "ArrowLeft") frame.scrollLeft -= step;
    else if (event.key === "ArrowDown") frame.scrollTop += step;
    else if (event.key === "ArrowUp") frame.scrollTop -= step;
    else if (event.key === "+" || event.key === "=") { zoom = ZOOMS[Math.min(ZOOMS.indexOf(zoom) + 1, ZOOMS.length - 1)]; render(); }
    else if (event.key === "-") { zoom = ZOOMS[Math.max(ZOOMS.indexOf(zoom) - 1, 0)]; render(); }
    else if (event.key === "0") { zoom = 0.75; render(); }
    else return;
    event.preventDefault();
  });
  frame.addEventListener("click", (event) => {
    const target = event.target.closest("[data-id]");
    if (target) select(target.dataset.id);
  });
  $("#drawer-close").addEventListener("click", () => {
    const id = state.selectedId;
    dispatch({ type: "close" });
    frame.querySelector(`[data-id="${id}"]`)?.focus();
  });
  $("#drawer-body").addEventListener("click", (event) => {
    const target = event.target.closest("[data-select]");
    if (target) select(target.dataset.select);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.drawerOpen) {
      const id = state.selectedId;
      dispatch({ type: "close" });
      frame.querySelector(`[data-id="${id}"]`)?.focus();
    }
  });

  $("#toasts").addEventListener("click", (event) => {
    const id = event.target.closest("[data-dismiss]")?.dataset.dismiss;
    if (id) dismiss(id);
  });
  $("#toasts").addEventListener("mouseenter", () => {
    for (const toast of state.toasts) clearTimeout(timers.get(toast.id));
  });
  $("#toasts").addEventListener("mouseleave", () => {
    for (const toast of state.toasts) {
      const duration = toastDuration(toast.kind);
      if (duration !== null) timers.set(toast.id, setTimeout(() => dismiss(toast.id), duration));
    }
  });

  $("#assistant-toggle").addEventListener("click", () => dispatch({ type: "assistant", open: !state.assistantOpen }));
  $("#assistant-close").addEventListener("click", () => dispatch({ type: "assistant", open: false }));
  $("#plan-the-run").addEventListener("click", () => {
    notify("success", "Draft saved. The plan is drawn from it.");
    setTab("plan", true);
  });
  $("#toast-success").addEventListener("click", () => notify("success", "Draft saved."));
  $("#toast-danger").addEventListener("click", () => notify("danger", "The run could not be planned. Nothing was started. Try again."));

  phoneQuery.addEventListener("change", render);
}

function staticCopy() {
  $("#goal").value = EXAMPLE_GOALS[0];
  $("#examples").innerHTML = EXAMPLE_GOALS.map((goal) => `<li><button type="button" class="chip" data-goal="${esc(goal)}">${esc(goal)}</button></li>`).join("");
  $("#examples").addEventListener("click", (event) => {
    const goal = event.target.closest("[data-goal]")?.dataset.goal;
    if (goal) $("#goal").value = goal;
  });
  $("#state-legend").innerHTML = Object.entries(STATE).map(([key, s]) => {
    const reason = s.reason ? "Shows its reason in words" : "No reason line";
    return `<li>${stateWord(key)}<span class="why">${esc(reason)}</span></li>`;
  }).join("");
  const examples = [
    ["Recorded", costLabel({ kind: "recorded", usd: 0.0212 }), false],
    ["Recorded zero", costLabel({ kind: "recorded", usd: 0 }), false],
    ["Estimate", costLabel({ kind: "estimate", usd: 0.09 }), false],
    ["Estimate, not known", costLabel({ kind: "estimate", usd: null }), true],
    ["No model call", costLabel({ kind: "none" }), true],
  ];
  $("#cost-examples").innerHTML = examples.map(([label, value, missing]) =>
    `<li><p class="label">${esc(label)}</p><p class="figure${missing ? " is-missing" : ""}">${esc(value)}</p></li>`).join("");
}

staticCopy();
bind();
render();
// Mark the first draw as fresh once, so the steps and edges enter once and do not replay on every change.
setTimeout(() => { $("#frame").classList.remove("fresh"); }, 1200);
