// Captures the prototype in headless Chromium and measures what the mixed plan claims. Run from anywhere:
//   node /home/user/meridian/docs/design/prototype/capture.mjs
// It serves this folder on localhost (module scripts do not load from file://), writes PNGs and measurements.json into ./screens, and
// exits non-zero if a measured claim fails. Fonts load from Google Fonts, so the screenshots show the real faces when the network allows.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const screens = join(here, "screens");
mkdirSync(screens, { recursive: true });
const types = { ".html": "text/html", ".css": "text/css", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json" };

const server = createServer((req, res) => {
  const path = resolve(here, `.${decodeURIComponent(new URL(req.url, "http://x").pathname)}`);
  if (!path.startsWith(here) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  res.end(readFileSync(path));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const results = {};
const failures = [];
const check = (name, ok, detail) => {
  results[name] = { ok: Boolean(ok), detail };
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
};

async function open(width, height, { system = "proposed", theme = "dark", reduced = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: reduced ? "reduce" : "no-preference" });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  // The theme is always set explicitly: Playwright's default colour scheme is light, and the page follows the system setting.
  await page.evaluate(([s, t]) => {
    document.documentElement.dataset.system = s;
    document.documentElement.dataset.theme = t;
  }, [system, theme]);
  // Colours ease over 120 ms when the theme changes; measure after they settle.
  await page.waitForTimeout(300);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

const tab = (page, name) => page.click(`[role="tab"][data-tab="${name}"]`);

// 0. The theme follows the system setting when nothing is chosen, and an explicit choice overrides it.
{
  const seen = {};
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    seen[`system-${scheme}`] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    seen[`explicit-dark-on-${scheme}`] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await context.close();
  }
  check("theme.follows-system-and-explicit-choice", seen["system-light"] === "rgb(255, 255, 255)" && seen["system-dark"] === "rgb(0, 0, 0)" && seen["explicit-dark-on-light"] === "rgb(0, 0, 0)", seen);
}

// 1. Fonts resolve for the proposal (Archivo, Instrument Sans, JetBrains Mono) and load under the shipped system (Sora, Inter, Geist Mono).
{
  const { context, page } = await open(1440, 1000, { system: "proposed" });
  const faces = await page.evaluate(async () => {
    await document.fonts.load('600 36px "Archivo"');
    await document.fonts.load('400 15px "Instrument Sans"');
    await document.fonts.load('400 13px "JetBrains Mono"');
    return ["600 36px Archivo", "400 15px \"Instrument Sans\"", "400 13px \"JetBrains Mono\""].map((f) => [f, document.fonts.check(f)]);
  });
  check("fonts.proposed.resolve", faces.every(([, ok]) => ok), faces);
  await context.close();
}

// 2. Trim to cap: the browser supports text-box, and the controls use it.
{
  const { context, page } = await open(1440, 1000);
  const support = await page.evaluate(() => ({ supported: CSS.supports("text-box", "trim-both cap alphabetic"), btn: getComputedStyle(document.querySelector(".btn-primary")).textBox }));
  check("trim.supported", support.supported, support);
  await context.close();
}

// 3. Container tiers: the title is 36 px in the full work area and 28 px once the assistant pushes the body narrower (proposed).
//    The shipped look steps by the window, so opening the assistant does not change its title.
for (const system of ["proposed", "shipped"]) {
  const { context, page } = await open(1440, 1000, { system });
  const sizes = {};
  sizes.closed = await page.evaluate(() => getComputedStyle(document.querySelector("#panel-brief .page-title")).fontSize);
  await page.click("#assistant-toggle");
  await page.waitForTimeout(50);
  sizes.open = await page.evaluate(() => getComputedStyle(document.querySelector("#panel-brief .page-title")).fontSize);
  sizes.bodyWidthOpen = await page.evaluate(() => document.querySelector("#panel-brief .screen-body").getBoundingClientRect().width);
  if (system === "proposed") check("tier.container.steps", sizes.closed === "36px" && sizes.open === "28px", sizes);
  else check("tier.shipped.by-window", sizes.closed === sizes.open, sizes);
  results[`tier.${system}`] = { detail: sizes };
  if (system === "proposed") await page.screenshot({ path: join(screens, "proposed-dark-1440-brief-assistant.png") });
  await context.close();
}

// 4. Identity and overlay: opening step details does not move any step on the canvas.
{
  const { context, page } = await open(1440, 1000);
  await tab(page, "plan");
  await page.waitForTimeout(1300);
  // Layout position within the canvas (offsetLeft/offsetTop), so frame scrolling does not count as movement.
  const layoutBox = (id) => page.evaluate((i) => { const n = document.querySelector(`.canvas [data-id="${i}"]`); return [n.offsetLeft, n.offsetTop, n.offsetWidth, n.offsetHeight]; }, id);
  const layoutBefore = await layoutBox("s6");
  await page.screenshot({ path: join(screens, "proposed-dark-1440-plan-canvas.png") });
  await page.click('.canvas [data-id="s6"]');
  await page.waitForTimeout(260);
  const titleFocused = await page.evaluate(() => document.activeElement?.id === "drawer-title");
  check("drawer.title-takes-focus", titleFocused, { titleFocused });
  const layoutAfter = await layoutBox("s6");
  const drawerVisible = await page.evaluate(() => !document.querySelector("#drawer").hidden);
  // The selected step is not under the overlay: its right edge is left of the drawer's left edge.
  const clear = await page.evaluate(() => { const r = document.querySelector(".canvas [data-id=\"s6\"]").getBoundingClientRect(); return { right: r.right, drawerLeft: innerWidth - 480 }; });
  check("overlay.canvas-still", JSON.stringify(layoutBefore) === JSON.stringify(layoutAfter) && drawerVisible, { layoutBefore, layoutAfter, drawerVisible });
  check("overlay.selected-step-not-covered", clear.right <= clear.drawerLeft, clear);
  await page.screenshot({ path: join(screens, "proposed-dark-1440-plan-drawer.png") });
  // Escape closes the details and returns focus to the step the reader was on.
  await page.keyboard.press("Escape");
  const focused = await page.evaluate(() => document.activeElement?.dataset?.id ?? null);
  const closed = await page.evaluate(() => document.querySelector("#drawer").hidden);
  check("drawer.escape.returns-focus", closed && focused === "s6", { closed, focused });
  await context.close();
}

// 5. Keyboard: Tab walks the steps in reading order (column by column, top to bottom).
{
  const { context, page } = await open(1440, 1000);
  await tab(page, "plan");
  await page.focus('.canvas [data-id="s1"]');
  const order = [];
  for (let i = 0; i < 9; i += 1) {
    order.push(await page.evaluate(() => document.activeElement?.dataset?.id ?? document.activeElement?.tagName));
    await page.keyboard.press("Tab");
  }
  const expected = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
  check("keyboard.reading-order", JSON.stringify(order.slice(0, 8)) === JSON.stringify(expected), order);
  await context.close();
}

// 5b. The skip link is the first stop, and the plan region scrolls with the arrow keys.
{
  const { context, page } = await open(1440, 1000);
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement?.className ?? null);
  check("keyboard.skip-link-first", first === "skip-link", { first });
  await tab(page, "plan");
  await page.focus("#frame");
  const before = await page.evaluate(() => document.querySelector("#frame").scrollLeft);
  await page.keyboard.press("ArrowRight");
  const after = await page.evaluate(() => document.querySelector("#frame").scrollLeft);
  check("keyboard.arrows-scroll-plan", after > before, { before, after });
  await context.close();
}

// 6. Visible restriction: a filter says what it hides, and selecting a hidden step clears the filter and says so.
{
  const { context, page } = await open(1440, 1000);
  await tab(page, "plan");
  await page.click('[data-filter="needs"]');
  const text = await page.textContent("#restriction");
  check("restriction.count-in-words", text.includes("Showing 2 of 8 steps"), text);
  await page.click('.canvas [data-id="s1"]');
  const notice = await page.textContent("#notice");
  const filter = await page.getAttribute('[data-filter="all"]', "aria-pressed");
  check("restriction.hidden-selection-never-silent", filter === "true" && /hidden by the filter/.test(notice), { filter, notice });
  await context.close();
}

// 7. Stable loading geometry: redrawing the plan moves nothing that a reader can see (layout shift stays at zero).
{
  const { context, page } = await open(1440, 1000);
  await tab(page, "plan");
  await page.waitForTimeout(1300);
  await page.evaluate(() => {
    window.__cls = 0;
    window.__sources = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__cls += e.value;
        for (const s of e.sources ?? []) window.__sources.push({ value: e.value, node: (s.node && (s.node.className || s.node.tagName)) || null, before: s.previousRect && [s.previousRect.y, s.previousRect.height], after: s.currentRect && [s.currentRect.y, s.currentRect.height] });
      }
    }).observe({ type: "layout-shift" });
  });
  await page.click("#redraw");
  await page.waitForTimeout(1500);
  const cls = await page.evaluate(() => window.__cls);
  const sources = await page.evaluate(() => window.__sources ?? []);
  check("loading.cls-zero", cls === 0, { cls, sources });
  await context.close();
}

// 8. One red action per screen: exactly one red-filled button on the Brief screen.
{
  const { context, page } = await open(1440, 1000);
  const redButtons = await page.evaluate(() => [...document.querySelectorAll("#panel-brief .btn")].filter((b) => getComputedStyle(b).backgroundColor === "rgb(255, 46, 56)").map((b) => b.textContent.trim()));
  check("one-red-action.brief", redButtons.length === 1, redButtons);
  await context.close();
}

// 9. Reduced motion: no animation runs for longer than an instant, and no infinite loop remains (the running edge is still).
{
  const { context, page } = await open(1440, 1000, { reduced: true });
  await tab(page, "plan");
  await page.waitForTimeout(400);
  const loops = await page.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations === Infinity).length);
  check("reduced-motion.no-loops", loops === 0, { loops });
  await context.close();
}

// 10. Phone: no horizontal page scroll, the canvas is replaced by the list, the sheet rises from the bottom, and the list keeps its order.
{
  const { context, page } = await open(390, 844);
  await tab(page, "plan");
  await page.waitForTimeout(200);
  const scroll = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  const canvasHidden = await page.evaluate(() => getComputedStyle(document.querySelector("#frame")).display === "none" || document.querySelector("#frame .canvas") === null);
  const order = await page.evaluate(() => [...document.querySelectorAll(".index .step-btn")].map((b) => b.dataset.id));
  check("phone.no-horizontal-scroll", scroll.scrollWidth <= scroll.clientWidth, scroll);
  check("phone.canvas-recomposed-as-list", canvasHidden && JSON.stringify(order) === JSON.stringify(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]), { canvasHidden, order });
  await page.screenshot({ path: join(screens, "proposed-dark-390-plan-list.png") });
  await page.click('.index .step-btn[data-id="s6"]');
  await page.waitForTimeout(260);
  const sheet = await page.evaluate(() => { const r = document.querySelector("#drawer").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, vh: innerHeight }; });
  check("phone.details-sheet", sheet.bottom <= sheet.vh + 1 && sheet.width >= 389, sheet);
  await page.screenshot({ path: join(screens, "proposed-dark-390-plan-sheet.png") });
  await context.close();
}

// 11. Every screen in both systems and both themes, for the record.
const shots = [
  ["proposed", "dark", 1440, 1000, "brief"], ["proposed", "light", 1440, 1000, "brief"],
  ["shipped", "dark", 1440, 1000, "brief"], ["shipped", "dark", 1440, 1000, "plan"],
  ["proposed", "light", 1440, 1000, "plan"], ["proposed", "dark", 1440, 1000, "components"],
  ["shipped", "dark", 1440, 1000, "components"], ["proposed", "dark", 390, 844, "brief"],
  ["shipped", "dark", 390, 844, "plan"],
];
for (const [system, theme, width, height, screen] of shots) {
  const { context, page } = await open(width, height, { system, theme });
  if (screen !== "brief") await tab(page, screen);
  await page.waitForTimeout(1300);
  await page.screenshot({ path: join(screens, `${system}-${theme}-${width}-${screen}.png`), fullPage: screen === "components" && width > 600 });
  await context.close();
}

// 12. Colour off: every state still reads without colour (the whole app in greyscale).
{
  const { context, page } = await open(1440, 1000);
  await tab(page, "components");
  await page.check("#greyscale");
  await page.waitForTimeout(200);
  await page.locator("#state-legend").screenshot({ path: join(screens, "proposed-dark-1440-states-greyscale.png") });
  const words = await page.evaluate(() => [...document.querySelectorAll("#state-legend .state-word")].map((w) => w.textContent.trim()));
  check("greyscale.every-state-has-a-word", words.length === 10 && new Set(words).size === 10, words);
  await context.close();
}

writeFileSync(join(screens, "measurements.json"), JSON.stringify({ url: "served from docs/design/prototype", results }, null, 2));
await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} claim(s):\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("\nAll measured claims hold.");
}
