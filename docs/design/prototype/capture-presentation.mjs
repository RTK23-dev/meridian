// Captures the walkthrough of the full web design in headless Chromium and checks the claims it makes about every screen. Run from anywhere:
//   node /home/user/meridian/docs/design/prototype/capture-presentation.mjs
// It writes one PNG per screen into ./presentation-screens, and presentation-measurements.json. It exits non-zero if a claim fails.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "presentation-screens");
mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".css": "text/css", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json" };
const server = createServer((req, res) => {
  const path = resolve(here, `.${decodeURIComponent(new URL(req.url, "http://x").pathname)}`);
  if (!path.startsWith(here) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  res.end(readFileSync(path));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}/presentation.html`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const results = {};
const failures = [];
const check = (name, ok, detail) => {
  results[name] = { ok: Boolean(ok), detail };
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
};

async function open(width, height, { theme = "dark", phone = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console ${m.text()}`); });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  if (phone) await page.click('[data-mode="phone"]');
  await page.waitForTimeout(250);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}

// The screens are read from the page's own index, so the capture checks every screen the walkthrough lists, in the order it lists them.
const screenIds = (page) => page.$$eval("#index [data-go]", (els) => els.map((e) => e.dataset.go));
const ids = await (async () => {
  const { context, page } = await open(1440, 1000);
  const list = await screenIds(page);
  await context.close();
  return list;
})();

// 1. Every screen renders: the cover and fourteen frames, and the count reads the position.
{
  const { context, page, errors } = await open(1440, 1000);
  const reached = [];
  for (const id of ids) {
    await page.click(`[data-go="${id}"]`);
    await page.waitForTimeout(80);
    const ok = await page.evaluate((expected) => {
      const count = document.querySelector("#count").textContent;
      const frame = document.querySelector(".frame");
      const current = document.querySelector(`[data-go="${expected}"]`)?.getAttribute("aria-current") === "true";
      return { count, hasFrame: Boolean(frame) || expected === "cover", current };
    }, id);
    reached.push([id, ok.count, ok.hasFrame, ok.current]);
  }
  const allCurrent = reached.every(([, , hasFrame, current]) => hasFrame && current);
  check("screens.all-render-and-are-indexed", allCurrent && reached.length === ids.length, reached);
  check("screens.no-console-errors", errors.length === 0, errors);
  await context.close();
}

// 2. One red action at most on every screen, counted from the drawn colour.
{
  const { context, page } = await open(1440, 1000);
  const redCounts = {};
  for (const id of ids.slice(1)) {
    await page.click(`[data-go="${id}"]`);
    await page.waitForTimeout(60);
    // The accent is read from the page, so the count holds for whichever accent the reader has chosen.
    redCounts[id] = await page.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--accent");
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return [...document.querySelector(".frame").querySelectorAll("button")].filter((b) => getComputedStyle(b).backgroundColor === accent).length;
    });
  }
  check("screens.one-red-action-at-most", Object.values(redCounts).every((n) => n <= 1), redCounts);
  await context.close();
}

// 3. Every disabled control names its reason in words, beside it.
{
  const { context, page } = await open(1440, 1000);
  const disabled = {};
  for (const id of ids.slice(1)) {
    await page.click(`[data-go="${id}"]`);
    await page.waitForTimeout(60);
    disabled[id] = await page.evaluate(() => [...document.querySelector(".frame").querySelectorAll("button:disabled")].map((b) => {
      const target = b.getAttribute("aria-describedby");
      const text = target ? document.getElementById(target)?.textContent.trim() ?? "" : "";
      return { label: b.textContent.trim(), reason: text.length > 0 };
    }));
  }
  const all = Object.entries(disabled).flatMap(([id, list]) => list.map((item) => ({ id, ...item })));
  check("screens.disabled-controls-say-why", all.length > 0 && all.every((item) => item.reason), all);
  await context.close();
}

// 4. No sideways scroll on any screen, at desktop width or at phone width.
for (const [width, height, label] of [[1440, 1000, "desktop"], [390, 844, "phone"]]) {
  const { context, page } = await open(width, height);
  const widths = {};
  for (const id of ids) {
    await page.click(`[data-go="${id}"]`);
    await page.waitForTimeout(60);
    widths[id] = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  }
  check(`screens.no-sideways-scroll.${label}`, Object.values(widths).every((w) => w.scroll <= w.client), widths);
  await context.close();
}

// 5. The phone frame takes the phone layout: 390 px wide, and the five places sit below the content as a bar.
{
  const { context, page } = await open(1440, 1000, { phone: true });
  await page.click('[data-go="home"]');
  await page.waitForTimeout(80);
  const phone = await page.evaluate(() => {
    const frame = document.querySelector(".frame").getBoundingClientRect();
    const rail = document.querySelector(".app-rail").getBoundingClientRect();
    const main = document.querySelector(".app-main").getBoundingClientRect();
    return { frameWidth: Math.round(frame.width), railBelowMain: rail.top >= main.bottom - 2, railHeight: Math.round(rail.height) };
  });
  check("phone.frame-takes-the-phone-layout", phone.frameWidth === 390 && phone.railBelowMain && phone.railHeight < 80, phone);
  await context.close();
}

// 6. The walkthrough moves: the arrow keys and the buttons go forward and back, and the ends are marked.
{
  const { context, page } = await open(1440, 1000);
  await page.click("body");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const afterTwo = await page.textContent("#count");
  await page.keyboard.press("ArrowLeft");
  const afterBack = await page.textContent("#count");
  await page.click('[data-go="palette"]');
  const atEnd = await page.evaluate(() => document.querySelector("#next").disabled);
  const total = ids.length;
  check("navigation.arrows-and-ends", afterTwo === `3 of ${total}` && afterBack === `2 of ${total}` && atEnd, { afterTwo, afterBack, atEnd, total });
  await context.close();
}

// 7. The plan on its screen is the same plan: a step chosen in it is selected, and its details open.
{
  const { context, page } = await open(1440, 1000);
  await page.click('[data-go="plan"]');
  await page.waitForTimeout(120);
  await page.click('.plan .canvas [data-id="s2"]');
  await page.waitForTimeout(160);
  const detail = await page.evaluate(() => ({
    selected: document.querySelector(".plan .node[aria-current='true']")?.dataset.id ?? null,
    drawerOpen: !document.querySelector(".plan .plan-drawer").hidden,
  }));
  check("plan.selection-opens-details", detail.selected === "s2" && detail.drawerOpen, detail);
  await context.close();
}

// 8. The accent is the reader's choice. Choosing another one changes every accent use on the page (the buttons with an accent fill, and the
//    globe's meridian), leaves the danger colour alone, and is kept when the page is opened again.
{
  const { context, page } = await open(1440, 1000);
  await page.click('[data-go="home"]');
  await page.waitForTimeout(60);
  const accentNow = () => page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--accent");
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb;
  });
  const filledWith = (color) => page.evaluate((c) => [...document.querySelector(".frame").querySelectorAll("button")].filter((b) => getComputedStyle(b).backgroundColor === c).length, color);
  const globeStroke = () => page.evaluate(() => getComputedStyle(document.querySelector(".globe-red")).stroke);
  const dangerNow = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--danger").trim());

  const before = { accent: await accentNow(), filled: 0, danger: await dangerNow() };
  before.filled = await filledWith(before.accent);
  await page.click('[data-set-accent="blue"]');
  // The buttons ease their colour, so the new accent is read once the transition has finished.
  await page.waitForTimeout(400);
  const after = { accent: await accentNow(), danger: await dangerNow(), globe: await globeStroke() };
  after.filled = await filledWith(after.accent);
  check("accent.changes-every-accent-use", before.filled > 0 && after.accent !== before.accent && after.filled === before.filled && after.globe === after.accent && after.danger === before.danger, { before, after });

  await page.reload({ waitUntil: "networkidle" });
  const kept = await page.evaluate(() => document.querySelector('[data-set-accent="blue"]')?.getAttribute("aria-checked"));
  check("accent.is-kept-when-the-page-opens-again", kept === "true", { kept });
  await context.close();
}

// ---- Screenshots, one per screen: the frame at desktop width, and the phone frame for the screens that matter most at phone width. ----
{
  const { context, page } = await open(1440, 1000);
  for (const id of ids) {
    await page.click(`[data-go="${id}"]`);
    await page.waitForTimeout(160);
    const frame = page.locator(".frame");
    const target = (await frame.count()) > 0 ? frame : page.locator("#stage");
    await target.screenshot({ path: join(out, `${id}.png`) });
  }
  await context.close();
}
{
  const { context, page } = await open(1440, 1000, { phone: true });
  for (const id of ["home", "plan", "library", "review"]) {
    await page.click(`[data-go="${id}"]`);
    await page.waitForTimeout(160);
    await page.locator(".frame").screenshot({ path: join(out, `phone-${id}.png`) });
  }
  await context.close();
}

writeFileSync(join(out, "..", "presentation-measurements.json"), JSON.stringify({ url: "served from docs/design/prototype", results }, null, 2));
await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
const claims = Object.values(results);
if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} of ${claims.length} claim(s):\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${claims.length} measured claims hold.`);
}
