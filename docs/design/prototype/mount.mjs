// One plan, drawn as a canvas, a strip or a list. The caller chooses the view, the controls to show, and whether the step details open
// over the plan. Several plans on one page share a selection: a choice made in one is passed on through onSelect, and the page sends
// the same select action to each of them.
import {
  FILTERS, GEOMETRY, KIND_LABEL, KIND_SHIPPED_ACCENT, REASON, STATE, STATE_COPY, costLabel, initialState, layoutSteps, reduce,
  restrictionText, visibleIds,
} from "./model.mjs";

const ZOOMS = [0.5, 0.75, 1];
const NEEDS = new Set(["paused", "not_connected", "failed", "stale"]);
/** Below this width a plan is drawn as its list: the same steps, in the same order, in a shape that fits a phone. */
export const NARROW = 360;
let sequence = 0;

export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dot = (shape) => `<span class="dot dot-${shape}" aria-hidden="true"></span>`;
const stateWord = (key) => `<span class="state-word" data-tone="${STATE[key].tone}">${dot(STATE[key].dot)}${esc(STATE[key].label)}</span>`;
const modelText = (step) => step.model ?? "No model call";
const isMissing = (text) => text === "not recorded" || text === "No model call";
const spoken = (text) => (text.startsWith("est. ") ? `estimated ${text.slice(5)}` : text.startsWith("$") ? `recorded ${text}` : text);
const VIEWS = [["canvas", "Canvas"], ["strip", "Strip"], ["list", "List"]];

export function mountPlan(root, options) {
  const plan = options.plan;
  const opts = { view: "canvas", filter: "all", selectedId: null, zoom: 0.75, bar: [], drawer: false, minimap: false, overview: false, label: "The plan", onSelect: null, onChange: null, ...options };
  const layout = layoutSteps(plan.steps);
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const placed = new Map(layout.nodes.map((node) => [node.id, node]));
  /** Reading order: column by column, top to bottom. Tab order, the strip and the list all follow it. */
  const reading = [...layout.nodes].sort((a, b) => a.column - b.column || a.row - b.row).map((node) => node.id);
  const number = new Map(reading.map((id, index) => [id, index + 1]));
  const uid = `plan-${++sequence}`;

  let state = { ...initialState(), view: opts.view, filter: opts.filter, selectedId: opts.selectedId };
  let zoom = opts.zoom;
  let fresh = true;
  let width = -1;

  const barMarkup = () => {
    const bar = opts.bar;
    const views = bar.includes("views") ? `<div class="seg" role="group" aria-label="View">${VIEWS.map(([v, l]) => `<button type="button" data-view="${v}" aria-pressed="false">${l}</button>`).join("")}</div>` : "";
    const filters = bar.includes("filters") ? `<div class="seg" role="group" aria-label="Filter">${Object.entries(FILTERS).map(([k, f]) => `<button type="button" data-filter="${k}" aria-pressed="false">${esc(f.label)}</button>`).join("")}</div>` : "";
    const restriction = bar.includes("filters") ? `<p class="restriction" data-restriction role="status"></p>` : "";
    const zoomControl = bar.includes("zoom") ? `<div class="zoom" data-zoom><button type="button" class="btn btn-quiet" data-zoom-out aria-label="Zoom out">−</button><span class="mono" data-zoom-level></span><button type="button" class="btn btn-quiet" data-zoom-in aria-label="Zoom in">+</button></div>` : "";
    const redraw = bar.includes("redraw") ? `<button type="button" class="btn btn-quiet" data-redraw>Redraw the plan</button>` : "";
    const resume = bar.includes("resume") ? `<div class="resume"><button type="button" class="btn btn-primary" data-resume disabled aria-describedby="${uid}-reason">Resume the run</button><p class="row-reason" id="${uid}-reason" data-resume-reason></p></div>` : "";
    return `${views || filters || zoomControl || redraw ? `<div class="bar-row">${views}${filters}${zoomControl}${redraw}</div>` : ""}${restriction}${resume}`;
  };

  root.classList.add("plan");
  root.classList.toggle("is-overview", opts.overview);
  root.innerHTML = `${opts.bar.length ? `<div class="plan-bar">${barMarkup()}</div>` : ""}
    <p class="plan-notice is-empty" role="status"></p>
    <div class="plan-frame" tabindex="0" role="region" aria-label="${esc(opts.label)}"></div>
    ${opts.minimap ? `<svg class="minimap" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true"><g class="minimap-steps"></g><rect class="minimap-view" x="0" y="0" width="0" height="0"></rect></svg>` : ""}
    ${opts.drawer ? `<aside class="plan-drawer" hidden aria-label="Step details"><div class="drawer-head"><p class="label" data-kind></p><button type="button" class="btn btn-quiet" data-close aria-label="Close step details">Close</button></div><div data-body></div></aside>` : ""}`;

  const frame = root.querySelector(".plan-frame");
  const notice = root.querySelector(".plan-notice");
  const drawer = root.querySelector(".plan-drawer");
  const minimap = root.querySelector(".minimap");
  const minimapSteps = root.querySelector(".minimap-steps");
  const minimapView = root.querySelector(".minimap-view");

  const narrow = () => root.clientWidth > 0 && root.clientWidth < NARROW;
  const effectiveView = () => (narrow() && state.view === "canvas" ? "list" : state.view);
  const accessibleName = (step, text) => `Step ${number.get(step.id)} of ${plan.steps.length}. ${KIND_LABEL[step.kind]}: ${step.title}. ${STATE[step.state].label}. ${modelText(step)}. ${spoken(text)}.`;

  function nodeMarkup(step, selected, dimmed) {
    const node = placed.get(step.id);
    const text = costLabel(step.cost);
    const classes = ["node", `is-${step.state}`];
    if (step.state === "not_connected") classes.push("is-blocked");
    if (step.state === "failed") classes.push("is-failed");
    if (step.state === "stale") classes.push("is-stale");
    if (dimmed) classes.push("is-dimmed");
    return `<button type="button" class="${classes.join(" ")}" data-id="${step.id}" data-accent="${KIND_SHIPPED_ACCENT[step.kind]}" style="left:${node.x}px;top:${node.y}px" aria-label="${esc(accessibleName(step, text))}"${selected ? ' aria-current="true"' : ""}>
      <span class="node-head"><span class="kind">${esc(KIND_LABEL[step.kind])}</span>${stateWord(step.state)}</span>
      <span class="title">${esc(step.title)}</span>
      <span class="model">${esc(modelText(step))}</span>
      <span class="node-foot${isMissing(text) ? " is-missing" : ""}">${esc(text)}</span></button>`;
  }

  function canvasMarkup(ids) {
    const size = `width:${layout.width}px;height:${layout.height}px`;
    if (state.loading) {
      const blocks = reading.map((id) => {
        const node = placed.get(id);
        return `<div class="node is-skeleton" aria-hidden="true" style="left:${node.x}px;top:${node.y}px"><span class="bar"></span><span class="bar short"></span><span class="bar"></span></div>`;
      }).join("");
      return `<div class="canvas" style="${size}" aria-busy="true">${blocks}</div>`;
    }
    const edges = layout.edges.map(({ from, to }) => {
      const a = placed.get(from);
      const b = placed.get(to);
      const x1 = a.x + GEOMETRY.nodeWidth;
      const y1 = a.y + GEOMETRY.nodeHeight / 2;
      const x2 = b.x;
      const y2 = b.y + GEOMETRY.nodeHeight / 2;
      const bend = GEOMETRY.columnGap / 2;
      const target = byId.get(to).state;
      const cls = target === "running" ? "edge-running" : ["done", "cache_hit"].includes(target) ? "edge-done" : target === "failed" ? "edge-failed" : "";
      return `<path pathLength="1" class="${cls}" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}"></path>`;
    }).join("");
    const nodes = reading.map((id) => nodeMarkup(byId.get(id), id === state.selectedId, !ids.includes(id))).join("");
    return `<div class="canvas" style="${size}"><svg class="edges" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">${edges}</svg>${nodes}</div>`;
  }

  function stripMarkup(ids) {
    const cards = reading.map((id) => byId.get(id)).filter((step) => ids.includes(step.id)).map((step) => {
      const text = costLabel(step.cost);
      return `<button type="button" class="strip-card is-${step.state}" data-id="${step.id}" data-accent="${KIND_SHIPPED_ACCENT[step.kind]}" aria-label="${esc(accessibleName(step, text))}"${step.id === state.selectedId ? ' aria-current="true"' : ""}>
        <span class="strip-head"><span class="kind">${esc(KIND_LABEL[step.kind])}</span>${stateWord(step.state)}</span>
        <span class="title">${esc(step.title)}</span>
        <span class="model">${esc(modelText(step))}</span>
        <span class="node-foot${isMissing(text) ? " is-missing" : ""}">${esc(text)}</span></button>`;
    }).join("");
    return `<div class="strip" role="group" aria-label="Steps, in reading order">${cards}</div>`;
  }

  function listMarkup(ids) {
    const rows = reading.map((id) => byId.get(id)).filter((step) => ids.includes(step.id)).map((step) => {
      const text = costLabel(step.cost);
      const reads = step.reads.length === 0 ? "Reads nothing. It starts the plan." : `Reads: ${step.reads.map((id) => byId.get(id).title).join(", ")}`;
      return `<li data-id="${step.id}"${step.id === state.selectedId ? ' aria-current="true"' : ""}>${stateWord(step.state)}<button type="button" class="step-btn" data-id="${step.id}" aria-label="${esc(accessibleName(step, text))}">${esc(step.title)}</button><span class="cell-text kind-cell">${esc(KIND_LABEL[step.kind])}</span><span class="cell-text mono model-cell">${esc(modelText(step))}</span><span class="cell-mono cost-cell${isMissing(text) ? " is-missing" : ""}">${esc(text)}</span><span class="cell-text reads-cell">${esc(reads)}</span></li>`;
    }).join("");
    return `<div class="index-head" aria-hidden="true"><span class="label">State</span><span class="label">Step</span><span class="label">Kind</span><span class="label">Model</span><span class="label label-right">Cost</span><span class="label">Reads</span></div><ul class="index" aria-label="Steps, in reading order">${rows}</ul>`;
  }

  function renderFrame(ids) {
    const view = effectiveView();
    // Rebuilding the frame resets its scroll, so the place the reader was in is kept across every change.
    const scroll = { left: frame.scrollLeft, top: frame.scrollTop };
    const focused = frame.contains(document.activeElement) ? document.activeElement.closest("[data-id]")?.dataset.id : undefined;
    frame.classList.toggle("is-flow", view !== "canvas");
    frame.classList.toggle("fresh", fresh);
    frame.setAttribute("aria-busy", String(state.loading));
    frame.innerHTML = view === "canvas" ? canvasMarkup(ids) : view === "strip" ? stripMarkup(ids) : listMarkup(ids);
    frame.scrollLeft = scroll.left;
    frame.scrollTop = scroll.top;
    if (focused) frame.querySelector(`[data-id="${focused}"]`)?.focus({ preventScroll: true });
    fresh = false;
    root.dataset.view = view;
  }

  function renderBar() {
    const view = effectiveView();
    root.dataset.narrow = String(narrow());
    for (const button of root.querySelectorAll("[data-view]")) {
      button.setAttribute("aria-pressed", String(button.dataset.view === view));
      button.hidden = narrow() && button.dataset.view === "canvas";
    }
    for (const button of root.querySelectorAll("[data-filter]")) button.setAttribute("aria-pressed", String(button.dataset.filter === state.filter));
    const restriction = root.querySelector("[data-restriction]");
    if (restriction) {
      restriction.innerHTML = state.loading
        ? "Redrawing the plan. Steps keep their places."
        : `${esc(restrictionText(state, plan))}${state.filter !== "all" ? ' <button type="button" class="btn btn-quiet" data-show-all>Show all steps</button>' : ""}`;
    }
    const zoomBox = root.querySelector("[data-zoom]");
    if (zoomBox) {
      zoomBox.hidden = view !== "canvas";
      zoomBox.querySelector("[data-zoom-level]").textContent = `${Math.round(zoom * 100)}%`;
      zoomBox.querySelector("[data-zoom-out]").disabled = zoom <= ZOOMS[0];
      zoomBox.querySelector("[data-zoom-in]").disabled = zoom >= ZOOMS[ZOOMS.length - 1];
    }
    const redraw = root.querySelector("[data-redraw]");
    if (redraw) redraw.disabled = state.loading;
    const resume = root.querySelector("[data-resume]");
    if (resume) {
      const needs = plan.steps.filter((step) => NEEDS.has(step.state));
      resume.disabled = needs.length > 0;
      root.querySelector("[data-resume-reason]").textContent = needs.length
        ? `Resume is off. These steps need you first: ${needs.map((step) => step.title).join("; ")}.`
        : "";
    }
    notice.classList.toggle("is-empty", !state.notice);
    notice.textContent = state.notice ?? "";
    root.style.setProperty("--zoom", String(zoom));
  }

  function renderDrawer() {
    if (!drawer) return;
    const step = state.selectedId ? byId.get(state.selectedId) : null;
    drawer.hidden = !(state.drawerOpen && step);
    drawer.style.top = `${frame.offsetTop}px`;
    if (!step || !state.drawerOpen) return;
    const text = costLabel(step.cost);
    const readBy = plan.steps.filter((other) => other.reads.includes(step.id));
    const ref = (other) => `<button type="button" class="ref" data-id="${other.id}">${esc(other.title)}</button>`;
    drawer.querySelector("[data-kind]").textContent = `${KIND_LABEL[step.kind]} · step ${number.get(step.id)} of ${plan.steps.length}`;
    drawer.querySelector("[data-body]").innerHTML = `
      <div class="drawer-state">${stateWord(step.state)}</div>
      <h3 class="drawer-title" tabindex="-1" data-title>${esc(step.title)}</h3>
      <p class="drawer-means">${esc(STATE_COPY[step.state].meaning)}</p>
      <dl class="drawer-facts">
        <div><dt>Model</dt><dd class="${step.model ? "mono" : ""}">${esc(modelText(step))}</dd></div>
        <div><dt>Cost</dt><dd class="${isMissing(text) ? "" : "mono"}">${esc(text)}</dd></div>
        <div><dt>Reads</dt><dd>${step.reads.length === 0 ? "Nothing. It starts the plan." : `<span class="ref-list">${step.reads.map((id) => ref(byId.get(id))).join("")}</span>`}</dd></div>
        <div><dt>Read by</dt><dd>${readBy.length === 0 ? "Nothing yet." : `<span class="ref-list">${readBy.map(ref).join("")}</span>`}</dd></div>
        ${REASON[step.state] ? `<div class="reason-row" data-tone="${STATE[step.state].tone}"><dt>Why it stopped</dt><dd>${esc(REASON[step.state])}</dd></div>` : ""}
        <div><dt>Next</dt><dd>${esc(STATE_COPY[step.state].next)}</dd></div>
      </dl>`;
  }

  /** The map shows the whole canvas at its own scale; the frame over it is what the frame shows. A click on the map moves there. */
  function updateViewport() {
    if (!minimap) return;
    minimap.classList.toggle("is-off", effectiveView() !== "canvas");
    minimapView.setAttribute("x", String(frame.scrollLeft / zoom));
    minimapView.setAttribute("y", String(frame.scrollTop / zoom));
    minimapView.setAttribute("width", String(frame.clientWidth / zoom));
    minimapView.setAttribute("height", String(frame.clientHeight / zoom));
  }

  function renderMinimap() {
    if (!minimap) return;
    minimapSteps.innerHTML = layout.nodes.map((node) => `<rect class="mm-step is-${byId.get(node.id).state}" x="${node.x}" y="${node.y}" width="${GEOMETRY.nodeWidth}" height="${GEOMETRY.nodeHeight}"></rect>`).join("");
    updateViewport();
  }

  function render() {
    const ids = visibleIds(state, plan);
    renderFrame(ids);
    renderBar();
    renderDrawer();
    renderMinimap();
  }

  /** The details panel covers the right 480 px of the plan. A step selected under it is scrolled clear, so nothing is hidden. */
  function keepClear(id) {
    if (!drawer || drawer.hidden || effectiveView() !== "canvas") return;
    const node = frame.querySelector(`.canvas [data-id="${id}"]`);
    if (!node) return;
    const overflow = node.getBoundingClientRect().right - (root.getBoundingClientRect().right - 480 - 16);
    if (overflow > 0) frame.scrollLeft += overflow;
    updateViewport();
  }

  function dispatch(action, { user = false } = {}) {
    state = reduce(state, action, plan);
    render();
    if (opts.onChange) opts.onChange(state);
    if (user && action.type === "select" && opts.onSelect) opts.onSelect(action.id);
  }

  function selectByUser(id) {
    dispatch({ type: "select", id }, { user: true });
    requestAnimationFrame(() => {
      keepClear(id);
      const title = drawer?.querySelector("[data-title]");
      if (title && !drawer.hidden) title.focus({ preventScroll: true });
    });
  }

  function closeDrawer() {
    const id = state.selectedId;
    dispatch({ type: "close" });
    if (id) frame.querySelector(`[data-id="${id}"]`)?.focus({ preventScroll: true });
  }

  function applyZoom() {
    root.style.setProperty("--zoom", String(zoom));
    renderBar();
    updateViewport();
  }

  function redraw() {
    fresh = true;
    dispatch({ type: "loading", on: true });
    setTimeout(() => {
      fresh = true;
      dispatch({ type: "loading", on: false });
    }, 900);
  }

  root.addEventListener("click", (event) => {
    const target = event.target;
    // Buttons only: the plan root carries data-view too, and a click inside it must not be read as a view change.
    const view = target.closest("button[data-view]");
    if (view && root.contains(view)) return dispatch({ type: "view", view: view.dataset.view }, { user: true });
    const filter = target.closest("button[data-filter]");
    if (filter && root.contains(filter)) return dispatch({ type: "filter", filter: filter.dataset.filter }, { user: true });
    if (target.closest("[data-show-all]")) return dispatch({ type: "filter", filter: "all" }, { user: true });
    if (target.closest("[data-zoom-in]")) { zoom = ZOOMS[Math.min(ZOOMS.indexOf(zoom) + 1, ZOOMS.length - 1)]; return applyZoom(); }
    if (target.closest("[data-zoom-out]")) { zoom = ZOOMS[Math.max(ZOOMS.indexOf(zoom) - 1, 0)]; return applyZoom(); }
    if (target.closest("[data-redraw]")) return redraw();
    if (target.closest("[data-close]")) return closeDrawer();
    const chosen = target.closest("[data-id]");
    if (chosen && root.contains(chosen)) return selectByUser(chosen.dataset.id);
  });

  frame.addEventListener("keydown", (event) => {
    if (event.target !== frame || effectiveView() !== "canvas") return;
    const step = 80;
    if (event.key === "ArrowRight") frame.scrollLeft += step;
    else if (event.key === "ArrowLeft") frame.scrollLeft -= step;
    else if (event.key === "ArrowDown") frame.scrollTop += step;
    else if (event.key === "ArrowUp") frame.scrollTop -= step;
    else if (event.key === "+" || event.key === "=") { zoom = ZOOMS[Math.min(ZOOMS.indexOf(zoom) + 1, ZOOMS.length - 1)]; applyZoom(); }
    else if (event.key === "-") { zoom = ZOOMS[Math.max(ZOOMS.indexOf(zoom) - 1, 0)]; applyZoom(); }
    else if (event.key === "0") { zoom = opts.zoom; applyZoom(); }
    else return;
    event.preventDefault();
  });
  frame.addEventListener("scroll", updateViewport, { passive: true });
  minimap?.addEventListener("click", (event) => {
    const box = minimap.getBoundingClientRect();
    const scale = Math.min(box.width / layout.width, box.height / layout.height);
    const x = (event.clientX - box.left - (box.width - layout.width * scale) / 2) / scale;
    const y = (event.clientY - box.top - (box.height - layout.height * scale) / 2) / scale;
    frame.scrollLeft = x * zoom - frame.clientWidth / 2;
    frame.scrollTop = y * zoom - frame.clientHeight / 2;
    updateViewport();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawer && !drawer.hidden) {
      event.preventDefault();
      closeDrawer();
    }
  });

  // Re-draw when the width crosses the narrow line, and when the first size is known. Height changes do not re-draw.
  const observer = new ResizeObserver(() => {
    if (root.clientWidth !== width) {
      width = root.clientWidth;
      render();
    }
  });
  observer.observe(root);
  render();

  return {
    root,
    dispatch: (action) => dispatch(action),
    getState: () => state,
    destroy: () => observer.disconnect(),
  };
}
