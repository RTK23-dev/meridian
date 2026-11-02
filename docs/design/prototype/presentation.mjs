// The walkthrough. It shows one screen at a time with its notes, mounts the plan where a screen has one, and keeps the index, the count
// and the address in step. Previous and Next, the arrow keys, and the Desktop and Phone switch move through it. Keys typed in a field,
// and keys pressed inside a plan (where the arrows scroll the plan), stay with that field or plan.
import { COVER, GROUPS, SCREENS, notesMarkup, railMarkup } from "./screens.mjs";
import { esc, mountPlan } from "./mount.mjs";
import { SAMPLE_PLAN } from "./model.mjs";

const ORDER = [COVER, ...SCREENS];
const stage = document.querySelector("#stage");
const index = document.querySelector("#index");
const count = document.querySelector("#count");
const prev = document.querySelector("#prev");
const next = document.querySelector("#next");
const modes = [...document.querySelectorAll("[data-mode]")];
let current = 0;
let phone = false;
let mounted = [];

index.innerHTML = GROUPS.map((group) => `<div class="pres-group"><p class="label">${esc(group.label)}</p>${group.ids.map((id) => {
  const screen = ORDER.find((s) => s.id === id);
  return `<button type="button" data-go="${esc(id)}">${esc(screen.label)}</button>`;
}).join("")}</div>`).join("");

const find = (id) => Math.max(0, ORDER.findIndex((s) => s.id === id));

function frameMarkup(screen) {
  const shell = screen.shell === "bare"
    ? `<div class="app-shell is-bare">${screen.html}</div>`
    : `<div class="app-shell">${railMarkup(screen.place)}<div class="app-main">${screen.html}</div></div>`;
  return `<div class="frame-wrap">
    <article class="frame${phone ? " is-phone" : ""}" aria-label="${esc(screen.title)}">${shell}${screen.overlay ?? ""}</article>
    <section class="notes" aria-label="Notes on this screen">${notesMarkup(screen.notes)}</section>
  </div>`;
}

function render() {
  for (const plan of mounted) plan.destroy();
  mounted = [];
  const screen = ORDER[current];
  stage.innerHTML = screen.id === "cover" ? screen.html : frameMarkup(screen);
  for (const root of stage.querySelectorAll('[data-mount="plan"]')) {
    mounted.push(mountPlan(root, {
      plan: SAMPLE_PLAN,
      view: "canvas",
      bar: ["views", "filters", "zoom", "redraw", "resume"],
      drawer: true,
      minimap: true,
      selectedId: "s4",
      label: "The plan, 8 steps",
    }));
  }
  for (const button of index.querySelectorAll("[data-go]")) {
    if (button.dataset.go === screen.id) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
  count.textContent = `${current + 1} of ${ORDER.length}`;
  prev.disabled = current === 0;
  next.disabled = current === ORDER.length - 1;
  for (const mode of modes) mode.setAttribute("aria-pressed", String((mode.dataset.mode === "phone") === phone));
  try { history.replaceState(null, "", `#${screen.id}`); } catch { /* the address bar may refuse; the screen still shows */ }
}

function go(i, { focus = false } = {}) {
  current = Math.max(0, Math.min(ORDER.length - 1, i));
  render();
  if (focus) {
    stage.scrollIntoView({ block: "start" });
    stage.focus({ preventScroll: true });
  }
}

index.addEventListener("click", (event) => {
  const id = event.target.closest("[data-go]")?.dataset.go;
  if (id) go(find(id), { focus: true });
});
prev.addEventListener("click", () => go(current - 1, { focus: true }));
next.addEventListener("click", () => go(current + 1, { focus: true }));
for (const mode of modes) {
  mode.addEventListener("click", () => {
    phone = mode.dataset.mode === "phone";
    render();
  });
}
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.target.closest?.("input, textarea, select, .plan")) return;
  if (event.key === "ArrowRight") { go(current + 1); event.preventDefault(); }
  if (event.key === "ArrowLeft") { go(current - 1); event.preventDefault(); }
});
document.addEventListener("submit", (event) => event.preventDefault());
window.addEventListener("hashchange", () => go(find(location.hash.slice(1))));
go(location.hash ? find(location.hash.slice(1)) : 0);
