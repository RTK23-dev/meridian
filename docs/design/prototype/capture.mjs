// Captures the prototype in headless Chromium and checks the claims the page makes. Run from anywhere:
//   node /home/user/meridian/docs/design/prototype/capture.mjs
// It serves this folder on localhost (module scripts do not load from file://), writes PNGs and measurements.json into ./screens, and
// exits non-zero if a claim fails. Fonts load from Google Fonts, so the screenshots show the real faces when the network allows.
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
const info = (name, detail) => { results[name] = { detail }; };

async function open(width, height, { theme = "dark", reduced = false, colorScheme } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: reduced ? "reduce" : "no-preference",
    ...(colorScheme ? { colorScheme } : {}),
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  // The theme is set explicitly, because Playwright's default colour scheme is light and the page follows the system.
  await page.evaluate((t) => {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }, theme);
  await page.waitForTimeout(300);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

// 0. The theme follows the system when nothing is chosen, and an explicit choice overrides it.
{
  const seen = {};
  for (const scheme of ["light", "dark"]) {
    const { context, page } = await open(1440, 1000, { theme: null, colorScheme: scheme });
    seen[`system-${scheme}`] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.waitForTimeout(250);
    seen[`explicit-dark-on-${scheme}`] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await context.close();
  }
  check("theme.follows-system-and-explicit-choice", seen["system-light"] === "rgb(255, 255, 255)" && seen["system-dark"] === "rgb(0, 0, 0)" && seen["explicit-dark-on-light"] === "rgb(0, 0, 0)", seen);
}

// 1. Fonts resolve for the proposal.
{
  const { context, page } = await open(1440, 1000);
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

// 3. Title tiers follow their space: the masthead by its width, a plate's title by its column.
{
  const wide = await open(1440, 1000);
  const masthead = await wide.page.evaluate(() => getComputedStyle(document.querySelector(".display")).fontSize);
  const tiers = await wide.page.evaluate(() => ({
    wide: getComputedStyle(document.querySelector(".tier-wide .tier-title")).fontSize,
    narrow: getComputedStyle(document.querySelector(".tier-narrow .tier-title")).fontSize,
  }));
  check("tier.column.steps", tiers.wide === "36px" && tiers.narrow === "28px", tiers);
  check("tier.masthead.steps", masthead === "104px", { masthead });
  await wide.context.close();
  const small = await open(390, 844);
  const phoneMasthead = await small.page.evaluate(() => getComputedStyle(document.querySelector(".display")).fontSize);
  check("tier.masthead.phone", phoneMasthead === "44px", { phoneMasthead });
  await small.context.close();
}

// 4. The brief: opening the assistant narrows the brief's column, and nothing else on the page moves.
{
  const { context, page } = await open(1440, 1000);
  const before = await page.evaluate(() => document.querySelector("#brief-plate .brief-column").getBoundingClientRect().width);
  const planBefore = await page.evaluate(() => document.querySelector("#plan-main .node[data-id='s6']").offsetLeft);
  await page.click("#assistant-toggle");
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => document.querySelector("#brief-plate .brief-column").getBoundingClientRect().width);
  const planAfter = await page.evaluate(() => document.querySelector("#plan-main .node[data-id='s6']").offsetLeft);
  check("assistant.narrows-the-brief-column", after < before - 200 && planAfter === planBefore, { before, after, planBefore, planAfter });
  await context.close();
}

// 5. Overlay: opening step details does not move a step on the plan, and the step stays clear of the panel.
{
  const { context, page } = await open(1440, 1000);
  await page.waitForTimeout(1300);
  const layoutBox = (id) => page.evaluate((i) => { const n = document.querySelector(`#plan-main .canvas [data-id="${i}"]`); return [n.offsetLeft, n.offsetTop, n.offsetWidth, n.offsetHeight]; }, id);
  const layoutBefore = await layoutBox("s6");
  await page.click('#plan-main .canvas [data-id="s6"]');
  await page.waitForTimeout(260);
  const layoutAfter = await layoutBox("s6");
  const drawerVisible = await page.evaluate(() => !document.querySelector("#plan-main .plan-drawer").hidden);
  check("overlay.canvas-still", JSON.stringify(layoutBefore) === JSON.stringify(layoutAfter) && drawerVisible, { layoutBefore, layoutAfter, drawerVisible });
  const clear = await page.evaluate(() => {
    const node = document.querySelector("#plan-main .canvas [data-id='s6']").getBoundingClientRect();
    const root = document.querySelector("#plan-main").getBoundingClientRect();
    return { right: node.right, drawerLeft: root.right - 480 };
  });
  check("overlay.selected-step-not-covered", clear.right <= clear.drawerLeft, clear);
  const titleFocused = await page.evaluate(() => document.activeElement?.hasAttribute("data-title") ?? false);
  check("drawer.title-takes-focus", titleFocused, { titleFocused });
  await page.keyboard.press("Escape");
  const focused = await page.evaluate(() => document.activeElement?.dataset?.id ?? null);
  const closed = await page.evaluate(() => document.querySelector("#plan-main .plan-drawer").hidden);
  check("drawer.escape.returns-focus", closed && focused === "s6", { closed, focused });
  await context.close();
}

// 6. The thread: a step chosen in one plate is selected in every plate.
{
  const { context, page } = await open(1440, 1000);
  await page.click('#plan-main .canvas [data-id="s2"]');
  await page.waitForTimeout(120);
  const selected = await page.evaluate(() => ({
    main: document.querySelector("#plan-main .node[aria-current='true']")?.dataset.id ?? null,
    strip: document.querySelector("#plan-strip .strip-card[aria-current='true']")?.dataset.id ?? null,
    filter: document.querySelector("#plan-filter li[aria-current='true']")?.dataset.id ?? null,
    overview: document.querySelector("#plan-overview .node[aria-current='true']")?.dataset.id ?? null,
  }));
  check("thread.selection-shared", selected.main === "s2" && selected.strip === "s2" && selected.overview === "s2", selected);
  await context.close();
}

// 7. The overview is a map: it sits above the canvas, and a click on it moves the canvas to that place.
{
  const { context, page } = await open(1440, 1000);
  const map = await page.evaluate(() => {
    const root = document.querySelector("#plan-overview");
    const minimap = root.querySelector(".minimap").getBoundingClientRect();
    const frame = root.querySelector(".plan-frame");
    return { isOverview: root.classList.contains("is-overview"), mapHeight: minimap.height, mapTop: minimap.top, frameTop: frame.getBoundingClientRect().top };
  });
  check("overview.is-a-map-above-the-canvas", map.isOverview && map.mapHeight > 20 && map.mapTop < map.frameTop, map);
  // The map sits below the fold, so bring it into view before a pointer click, the way a reader would.
  const panned = await page.evaluate(async () => {
    const frame = document.querySelector("#plan-overview .plan-frame");
    const minimap = document.querySelector("#plan-overview .minimap");
    minimap.scrollIntoView({ block: "center" });
    await new Promise((ok) => requestAnimationFrame(() => ok()));
    const box = minimap.getBoundingClientRect();
    return { before: frame.scrollLeft, box: [box.left, box.top, box.width, box.height] };
  });
  await page.mouse.click(panned.box[0] + panned.box[2] * 0.9, panned.box[1] + panned.box[3] / 2);
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => document.querySelector("#plan-overview .plan-frame").scrollLeft);
  check("overview.click-pans-the-canvas", after > panned.before, { before: panned.before, after });
  await context.close();
}

// 8. Keyboard: the skip link is first; Tab walks the eight steps in reading order; arrow keys scroll the plan when it has focus.
{
  const { context, page } = await open(1440, 1000);
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement?.className ?? null);
  check("keyboard.skip-link-first", first === "skip-link", { first });
  await page.focus('#plan-main .canvas [data-id="s1"]');
  const order = [];
  for (let i = 0; i < 9; i += 1) {
    order.push(await page.evaluate(() => document.activeElement?.dataset?.id ?? document.activeElement?.tagName));
    await page.keyboard.press("Tab");
  }
  check("keyboard.reading-order", JSON.stringify(order.slice(0, 8)) === JSON.stringify(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]), order);
  await page.focus("#plan-main .plan-frame");
  const left = await page.evaluate(() => document.querySelector("#plan-main .plan-frame").scrollLeft);
  await page.keyboard.press("ArrowRight");
  const right = await page.evaluate(() => document.querySelector("#plan-main .plan-frame").scrollLeft);
  check("keyboard.arrows-scroll-plan", right > left, { left, right });
  await context.close();
}

// 9. Restriction: a filter says what it hides; selecting a hidden step clears the filter and says so.
{
  const { context, page } = await open(1440, 1000);
  await page.click('#plan-filter [data-filter="needs"]');
  const text = await page.textContent("#plan-filter [data-restriction]");
  check("restriction.count-in-words", text.includes("Showing 2 of 8 steps"), text);
  // The main plan is still on All steps, so it hides nothing until it is filtered too. Then a hidden step is chosen.
  await page.click('#plan-main [data-filter="needs"]');
  await page.click('#plan-main .canvas [data-id="s1"]');
  const notice = await page.textContent("#plan-main .plan-notice");
  const filter = await page.getAttribute('#plan-main [data-filter="all"]', "aria-pressed");
  check("restriction.hidden-selection-never-silent", filter === "true" && /hidden by the filter/.test(notice), { filter, notice });
  await context.close();
}

// 10. Redraw keeps every place: no layout shift while the plan reloads.
{
  const { context, page } = await open(1440, 1000);
  await page.waitForTimeout(1300);
  await page.evaluate(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift" });
  });
  await page.click("#plan-redraw [data-redraw]");
  await page.waitForTimeout(1500);
  const cls = await page.evaluate(() => window.__cls);
  check("loading.cls-zero", cls === 0, { cls });
  await context.close();
}

// 11. One red action per screen: exactly one red-filled button in the brief.
{
  const { context, page } = await open(1440, 1000);
  const red = await page.evaluate(() => [...document.querySelectorAll("#brief-plate .btn")].filter((b) => getComputedStyle(b).backgroundColor === "rgb(255, 46, 56)").map((b) => b.textContent.trim()));
  check("one-red-action.brief", red.length === 1, red);
  await context.close();
}

// 12. Reduced motion: nothing loops (the running line, the globe and the running edge all stop).
{
  const { context, page } = await open(1440, 1000, { reduced: true });
  await page.waitForTimeout(400);
  const loops = await page.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations === Infinity).length);
  check("reduced-motion.no-loops", loops === 0, { loops });
  await context.close();
}

// 13. Phone: no sideways scroll; the canvas becomes the list in the same order; the details rise as a sheet.
{
  const { context, page } = await open(390, 844);
  const scroll = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  check("phone.no-horizontal-scroll", scroll.scrollWidth <= scroll.clientWidth, scroll);
  const list = await page.evaluate(() => ({ view: document.querySelector("#plan-phone").dataset.view, order: [...document.querySelectorAll("#plan-phone .step-btn")].map((b) => b.dataset.id) }));
  check("phone.canvas-recomposed-as-list", list.view === "list" && JSON.stringify(list.order) === JSON.stringify(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]), list);
  await page.click('#plan-main .step-btn[data-id="s6"]');
  await page.waitForTimeout(260);
  const sheet = await page.evaluate(() => {
    const drawer = document.querySelector("#plan-main .plan-drawer").getBoundingClientRect();
    const root = document.querySelector("#plan-main").getBoundingClientRect();
    return { bottomGap: Math.abs(drawer.bottom - root.bottom), width: drawer.width, rootWidth: root.width };
  });
  check("phone.details-sheet", sheet.bottomGap < 2 && Math.abs(sheet.width - sheet.rootWidth) < 2, sheet);
  await context.close();
}

// 14. The state and cost plates say what each thing means.
{
  const { context, page } = await open(1440, 1000);
  const plates = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll("#state-grid .state-tile")];
    const words = tiles.map((t) => t.querySelector(".state-word").textContent.trim());
    const complete = tiles.every((t) => [...t.querySelectorAll("dd")].every((d) => d.textContent.trim().length > 0));
    return { states: tiles.length, distinct: new Set(words).size, complete, costs: document.querySelectorAll("#cost-grid .cost-tile").length };
  });
  check("states.ten-distinct-complete", plates.states === 10 && plates.distinct === 10 && plates.complete, plates);
  check("money.four-tiles", plates.costs === 4, { costs: plates.costs });
  await context.close();
}

// 15. Colour off: every state still reads (the state words are distinct with colour removed).
{
  const { context, page } = await open(1440, 1000);
  await page.check("#greyscale");
  await page.waitForTimeout(150);
  const greyed = await page.evaluate(() => getComputedStyle(document.querySelector(".chapters")).filter);
  check("greyscale.applies", greyed.includes("grayscale"), { filter: greyed });
  await context.close();
}

// ---- Screenshots, for the record. ----
for (const [name, width, height, theme, full] of [
  ["page-1440-dark", 1440, 1000, "dark", false],
  ["page-1440-light", 1440, 1000, "light", false],
  ["page-390-dark", 390, 844, "dark", false],
]) {
  const { context, page } = await open(width, height, { theme });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(screens, `${name}.png`), fullPage: full });
  await context.close();
}

info("claims", Object.keys(results).filter((key) => "ok" in results[key]).length);
writeFileSync(join(screens, "measurements.json"), JSON.stringify({ url: "served from docs/design/prototype", results }, null, 2));
await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
const claims = Object.values(results).filter((r) => "ok" in r);
if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} of ${claims.length} claim(s):\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${claims.length} measured claims hold.`);
}
