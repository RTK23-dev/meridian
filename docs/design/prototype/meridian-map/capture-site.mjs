// Checks the site background in headless Chromium, and saves a screenshot at each stop. Run from anywhere:
//   node /home/user/meridian/docs/design/prototype/meridian-map/capture-site.mjs
// It exits non-zero if a claim fails. Screenshots go to ./site-screens, and site-measurements.json records each claim.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "site-screens");
mkdirSync(out, { recursive: true });
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

async function open(width, height, { reduced = false, colorScheme = "dark" } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: reduced ? "reduce" : "no-preference",
    colorScheme,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console ${m.text()}`); });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  return { context, page, errors };
}

// A digest of the map canvas: the distinct colours it draws, and a hash of its pixels, so two positions can be compared.
const mapDigest = (page) => page.evaluate(() => {
  const canvas = document.querySelector("#map");
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  const colours = new Set();
  let hash = 0;
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    colours.add(key);
    hash = (hash * 31 + key) >>> 0;
  }
  return { colours: [...colours].map((c) => `#${c.toString(16).padStart(6, "0")}`), hash };
});

// The yellow dots on a bill: how many are printed. A bill printed in full has more than one printed dot than a bill still blank.
const billPrinted = (page, index) => page.evaluate((i) => {
  const canvas = document.querySelectorAll("canvas.bill")[i];
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let k = 3; k < data.length; k += 4) if (data[k] > 0) n += 1;
  return n;
}, index);

// ---- 1. The stops render with no errors: the map is drawn, and the page carries its five stops and the loop screen. ----
{
  const { context, page, errors } = await open(1440, 900);
  const digest = await mapDigest(page);
  const stops = await page.$$eval("main > section", (els) => els.map((el) => el.id));
  check("map.drawn-in-two-colours", digest.colours.length === 2, { colours: digest.colours });
  check("site.stops-and-loop-screen-present", stops.join(",") === "cover,create,library,insights,settings,cover-loop", stops);
  check("site.no-console-errors", errors.length === 0, errors);
  await context.close();
}

// ---- 2. The map follows the scroll: moving to another stop changes the part of the map shown. ----
{
  const { context, page } = await open(1440, 900);
  const at0 = await mapDigest(page);
  await page.evaluate(() => window.scrollTo({ top: window.innerHeight * 2, behavior: "instant" }));
  await page.waitForTimeout(1200);
  const at2 = await mapDigest(page);
  check("map.changes-with-the-scroll", at0.hash !== at2.hash, { at0: at0.hash, at2: at2.hash });
  await context.close();
}

// ---- 3. The bills print with the scroll: a bill in the middle of the screen is printed more than one that is off it. ----
{
  const { context, page } = await open(1440, 900);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(500);
  const centred = await billPrinted(page, 0);
  // The second bill sits below the fold, so it is printed less than the first.
  const below = await billPrinted(page, 1);
  // The page snaps to whole screens, so the move is to the next screen, where the first bill has left the middle of the window.
  await page.evaluate(() => window.scrollTo({ top: window.innerHeight, behavior: "instant" }));
  await page.waitForTimeout(500);
  const moved = await billPrinted(page, 0);
  check("bills.print-more-in-the-middle", centred > below, { centred, below });
  check("bills.reveal-changes-as-the-page-moves", centred !== moved, { centred, moved });
  await context.close();
}

// ---- 4. The loop: a reader who reaches the loop screen lands back on the first stop, and the map is the same part of the world. ----
{
  const { context, page } = await open(1440, 900);
  await page.evaluate(() => window.scrollTo({ top: window.innerHeight * 4, behavior: "instant" }));
  await page.waitForTimeout(900);
  const before = await mapDigest(page);
  await page.evaluate(() => window.scrollTo({ top: window.innerHeight * 5, behavior: "instant" }));
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => window.scrollY);
  check("loop.returns-to-the-first-stop", after < 2, { scrollY: after });
  await page.waitForTimeout(900);
  const back = await mapDigest(page);
  check("loop.map-is-the-first-stops-part-of-the-world", back.colours.length === 2 && before.hash !== back.hash, { before: before.hash, back: back.hash });
  await context.close();
}

// ---- 5. Nothing scrolls sideways, at desktop width or at phone width. ----
for (const [width, height, label] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
  const { context, page } = await open(width, height);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`layout.no-sideways-scroll.${label}`, sideways <= 0, { sideways });
  await context.close();
}

// ---- 6. Reduced motion: the map does not glide. It is drawn at its stop at once, so the first frame after a jump is the last one. ----
{
  const { context, page } = await open(1440, 900, { reduced: true });
  await page.evaluate(() => window.scrollTo({ top: window.innerHeight * 2, behavior: "instant" }));
  await page.waitForTimeout(60);
  const early = await mapDigest(page);
  await page.waitForTimeout(900);
  const late = await mapDigest(page);
  check("motion.reduced-holds-the-map-still", early.hash === late.hash, { early: early.hash, late: late.hash });
  await context.close();
}

// ---- Screenshots: each stop at desktop width, and the first stop at phone width. ----
{
  const { context, page } = await open(1440, 900);
  const stops = ["cover", "create", "library", "insights", "settings"];
  for (const [i, id] of stops.entries()) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), 900 * i);
    await page.waitForTimeout(1300);
    await page.screenshot({ path: join(out, `${id}.png`) });
  }
  await context.close();
}
{
  const { context, page } = await open(390, 844);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(out, "phone-cover.png") });
  await context.close();
}

writeFileSync(join(here, "site-measurements.json"), JSON.stringify({ url: "served from docs/design/prototype/meridian-map", results }, null, 2));
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
