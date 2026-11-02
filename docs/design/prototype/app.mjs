// The page controller. It mounts each plan, builds the state and cost plates from the model, and wires the brief, the notices and the
// switches. Every line of text comes from the model or from the page, and is escaped before it reaches the page.
import { esc, mountPlan } from "./mount.mjs";
import { wireAccent } from "./accent.mjs";
import { COST_COPY, EXAMPLE_GOALS, SAMPLE_PLAN, STATE, STATE_COPY, costLabel, toastDuration } from "./model.mjs";

const $ = (selector, scope = document) => scope.querySelector(selector);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

// ---- Plans. One selection is shared: a choice in any plan selects the step in all of them. ----
const plans = [];
/** The plan the choice was made in keeps its own state, including any notice it has just raised. The others follow the choice. */
const share = (id, source) => {
  for (const plan of plans) if (plan.root !== source) plan.dispatch({ type: "select", id });
};
const mount = (selector, options) => {
  const root = $(selector);
  const plan = mountPlan(root, { plan: SAMPLE_PLAN, selectedId: "s4", ...options, onSelect: (id) => share(id, root) });
  plans.push(plan);
  return plan;
};

mount("#plan-main", {
  view: "canvas",
  bar: ["views", "filters", "zoom", "redraw", "resume"],
  drawer: true,
  minimap: true,
  label: "The full plan, 8 steps",
  resume: true,
});
mount("#plan-strip", { view: "strip", label: "The plan as a strip, in reading order" });
mount("#plan-overview", { view: "canvas", minimap: true, overview: true, bar: ["redraw"], label: "An overview of the plan" });
mount("#plan-filter", { view: "list", bar: ["filters"], filter: "needs", label: "The plan, filtered to steps that need you", selectedId: "s6" });
mount("#plan-redraw", { view: "canvas", bar: ["redraw"], label: "A plan that can be redrawn" });
mount("#plan-phone", { view: "canvas", label: "The plan on a phone-width screen", selectedId: "s6" });

// ---- The state and cost plates, rendered from the model so they cannot drift from the app's words. ----
$("#state-grid").innerHTML = Object.entries(STATE).map(([key, state]) => `
  <article class="state-tile">
    <p class="state-word" data-tone="${state.tone}"><span class="dot dot-${state.dot}" aria-hidden="true"></span>${esc(state.label)}</p>
    <dl>
      <div><dt>Means</dt><dd>${esc(STATE_COPY[key].meaning)}</dd></div>
      <div><dt>Next</dt><dd>${esc(STATE_COPY[key].next)}</dd></div>
    </dl>
  </article>`).join("");

const costs = [
  { label: "Recorded", figure: costLabel({ kind: "recorded", usd: 0.0212 }), copy: COST_COPY.recorded, missing: false },
  { label: "Estimate", figure: costLabel({ kind: "estimate", usd: 0.09 }), copy: COST_COPY.estimate, missing: false },
  { label: "Not known", figure: costLabel({ kind: "estimate", usd: null }), copy: COST_COPY.unknown, missing: true },
  { label: "No model call", figure: costLabel({ kind: "none" }), copy: COST_COPY.none, missing: true },
];
$("#cost-grid").innerHTML = costs.map((cost) => `
  <article class="cost-tile">
    <p class="label">${esc(cost.label)}</p>
    <p class="cost-figure${cost.missing ? " is-missing" : ""}">${esc(cost.figure)}</p>
    <p class="cost-copy">${esc(cost.copy)}</p>
  </article>`).join("");

// ---- The brief. ----
$("#goal").value = EXAMPLE_GOALS[0];
$("#examples").innerHTML = EXAMPLE_GOALS.map((goal) => `<li><button type="button" class="chip" data-goal="${esc(goal)}">${esc(goal)}</button></li>`).join("");
$("#examples").addEventListener("click", (event) => {
  const goal = event.target.closest("[data-goal]")?.dataset.goal;
  if (goal) $("#goal").value = goal;
});
$("#assistant-toggle").addEventListener("click", () => {
  const open = $("#brief-plate").dataset.assistant !== "open";
  $("#brief-plate").dataset.assistant = open ? "open" : "closed";
  $("#assistant-toggle").setAttribute("aria-expanded", String(open));
  $("#assistant").hidden = !open;
});
$("#assistant-close").addEventListener("click", () => $("#assistant-toggle").click());
$("#plan-the-run").addEventListener("click", () => {
  notify("success", "Draft saved. The plan is drawn from it.");
  $("#plan-main").scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
});

// ---- Notices. A passing confirmation leaves by itself; a failure stays until it is closed. ----
function notify(kind, text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.kind = kind;
  toast.setAttribute("role", "status");
  toast.innerHTML = `<span></span><button type="button" class="btn btn-quiet">Dismiss</button>`;
  toast.querySelector("span").textContent = text;
  toast.querySelector("button").addEventListener("click", () => toast.remove());
  $("#toasts").append(toast);
  const duration = toastDuration(kind);
  if (duration !== null) setTimeout(() => toast.remove(), duration);
}
$("#toast-success").addEventListener("click", () => notify("success", "Draft saved."));
$("#toast-danger").addEventListener("click", () => notify("danger", "The run could not be planned. Nothing was started. Try again."));

// ---- Switches: the accent, the theme, colour off. The theme follows the system until a choice is made. ----
function renderSwitches() {
  const current = document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  for (const button of document.querySelectorAll("[data-set-theme]")) button.setAttribute("aria-checked", String(button.dataset.setTheme === current));
}
wireAccent(document, window);
for (const button of document.querySelectorAll("[data-set-theme]")) {
  button.addEventListener("click", () => {
    document.documentElement.dataset.theme = button.dataset.setTheme;
    renderSwitches();
  });
}
$("#greyscale").addEventListener("change", (event) => document.documentElement.toggleAttribute("data-greyscale", event.target.checked));
renderSwitches();

// ---- The contents follows the reader: the chapter in view is marked. ----
const links = [...document.querySelectorAll(".contents a")];
const chapters = links.map((link) => document.querySelector(link.getAttribute("href")));
const marker = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    for (const link of links) link.removeAttribute("aria-current");
    links[chapters.indexOf(entry.target)]?.setAttribute("aria-current", "true");
  }
}, { rootMargin: "-40% 0px -55% 0px" });
for (const chapter of chapters) if (chapter) marker.observe(chapter);
