// Checks the simulator in headless Chromium. Run from anywhere:
//   node /home/user/meridian/docs/design/prototype/meridian-map/capture-tuner.mjs
// It checks that the simulator at its defaults draws the same map as the published site, and that each control does what it says.
// It writes screenshots to ./tuner-screens and tuner-measurements.json, and exits non-zero if a claim fails.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "tuner-screens");
mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".css": "text/css", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json" };
const server = createServer((req, res) => {
  const path = resolve(here, `.${decodeURIComponent(new URL(req.url, "http://x").pathname)}`);
  if (!path.startsWith(here) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  res.end(readFileSync(path));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const results = {};
const failures = [];
const check = (name, ok, detail) => {
  results[name] = { ok: Boolean(ok), detail };
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
};

async function open(file, width = 1440, height = 900, { reduced = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: reduced ? "reduce" : "no-preference", colorScheme: "dark" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console ${m.text()}`); });
  await page.goto(`${base}/${file}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  return { context, page, errors };
}

// A digest of the map canvas: its distinct colours, and a hash of its pixels, so two pages can be compared at the same position.
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
  return { colours: [...colours].map((c) => `#${c.toString(16).padStart(6, "0")}`), hash, cols: canvas.width, rows: canvas.height };
});
// The digest once the map has stopped gliding: it is taken again until two readings in a row agree, so a map still moving toward its stop
// is not compared with one that has arrived.
async function settledDigest(page) {
  let last = await mapDigest(page);
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(250);
    const next = await mapDigest(page);
    if (next.hash === last.hash) return next;
    last = next;
  }
  return last;
}
const billPrinted = (page, index) => page.evaluate((i) => {
  const canvas = document.querySelectorAll("canvas.bill")[i];
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let k = 3; k < data.length; k += 4) if (data[k] > 0) n += 1;
  return n;
}, index);
const readout = (page, id) => page.textContent(`#${id}`);
// Every pixel of the map is a mix of the ground and the block colour, since the blocks are drawn at varied opacity. Returns how many pixels
// are more than two steps off the line between the two colours, and how many colours there are.
const mixOf = (page, ground, ink) => page.evaluate(([bgHex, lineHex]) => {
  const parse = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [ar, ag, ab] = parse(bgHex);
  const [br, bg, bb] = parse(lineHex);
  const [dr, dg, db] = [br - ar, bg - ag, bb - ab];
  const len = dr * dr + dg * dg + db * db;
  const canvas = document.querySelector("#map");
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  const colours = new Set();
  let off = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    colours.add((r << 16) | (g << 8) | b);
    const t = Math.min(1, Math.max(0, ((r - ar) * dr + (g - ag) * dg + (b - ab) * db) / len));
    if (Math.abs(r - (ar + t * dr)) > 2 || Math.abs(g - (ag + t * dg)) > 2 || Math.abs(b - (ab + t * db)) > 2) off += 1;
  }
  return { off, distinct: colours.size };
}, [ground, ink]);
// Sets a range or colour control the way a reader does: the value, then the input event the drawer listens for.
const setRange = (page, id, value) => page.evaluate(([i, v]) => {
  const el = document.querySelector(`#${i}`);
  el.value = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, [id, value]);
// The number of blocks the simulator reports it drew.
const blockCount = async (page) => Number((await readout(page, "r-blocks")).replace(/[^0-9]/g, ""));
const settle = (page, ms = 1200) => page.waitForTimeout(ms);

// ---- 1. Parity: at its defaults the simulator draws the same map as the published site, at the same position. ----
{
  const site = await open("index.html");
  await site.page.evaluate(() => window.scrollTo({ top: window.innerHeight, behavior: "instant" }));
  await settle(site.page);
  const siteDigest = await settledDigest(site.page);
  const siteBill = await billPrinted(site.page, 1);
  await site.context.close();

  const tuner = await open("tuner.html");
  await tuner.page.evaluate(() => window.scrollTo({ top: window.innerHeight, behavior: "instant" }));
  await settle(tuner.page);
  const tunerDigest = await settledDigest(tuner.page);
  const tunerBill = await billPrinted(tuner.page, 1);
  const tunerMix = await mixOf(tuner.page, "#0B0B0C", "#1C1C1F");
  check("parity.map-matches-the-published-site-at-defaults", siteDigest.hash === tunerDigest.hash, { site: siteDigest.hash, tuner: tunerDigest.hash });
  check("parity.bill-matches-the-published-site-at-defaults", siteBill === tunerBill, { site: siteBill, tuner: tunerBill });
  check("parity.blocks-mixed-from-the-ground-and-ink-at-defaults", tunerMix.off === 0 && tunerMix.distinct > 2, { off: tunerMix.off, colours: tunerMix.distinct });
  check("site.no-console-errors", tuner.errors.length === 0 && site.errors.length === 0, { tuner: tuner.errors, site: site.errors });
  await tuner.context.close();
}

// ---- 2. The readout shows the real state: the stop, the latitude, and how much of the window is ink and how many blocks are drawn. ----
{
  const { context, page } = await open("tuner.html");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await settle(page);
  check("readout.starts-at-the-first-stop", (await readout(page, "r-stop")).startsWith("1 ·"), { stop: await readout(page, "r-stop") });
  const coverage = await readout(page, "r-coverage");
  const blocks = await blockCount(page);
  check("readout.shows-the-ink-and-the-blocks", /^\d+\.\d% of the window$/.test(coverage) && blocks > 0, { coverage, blocks });
  await context.close();
}

// ---- 3. Each value changes the map: the contour spacing changes the pattern, the grid spacing changes how many blocks are drawn, the
//      ground changes the colour, and the zoom changes the pattern. ----
{
  const { context, page } = await open("tuner.html");
  await page.evaluate(() => window.scrollTo({ top: window.innerHeight, behavior: "instant" }));
  await settle(page);
  const before = await mapDigest(page);
  const blocksBefore = await blockCount(page);
  await setRange(page, "k-step", "6");
  await settle(page, 700);
  const finer = await mapDigest(page);
  check("spacing.finer-contours-change-the-pattern", finer.hash !== before.hash, { before: before.hash, finer: finer.hash });
  await setRange(page, "k-step", "11");
  await settle(page, 500);
  await setRange(page, "k-pitch", "12");
  await settle(page, 700);
  const blocksWide = await blockCount(page);
  check("grid.wider-spacing-draws-fewer-blocks", blocksWide < blocksBefore, { atDefault: blocksBefore, atTwelve: blocksWide });
  await setRange(page, "k-pitch", "8");
  await settle(page, 500);

  await page.evaluate(() => {
    const el = document.querySelector("#k-bg");
    el.value = "#F4F4F2";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(page, 700);
  const paper = await mapDigest(page);
  const ink = await page.evaluate(() => getComputedStyle(document.querySelector(".lede")).color);
  check("ground.light-ground-draws-light-map-and-dark-text", paper.colours.includes("#f4f4f2") && ink === "rgb(10, 10, 10)", { colours: paper.colours, ink });

  await setRange(page, "k-zoom", "16");
  await settle(page, 700);
  const zoomed = await mapDigest(page);
  check("zoom.changes-the-pattern", zoomed.hash !== paper.hash, { paper: paper.hash, zoomed: zoomed.hash });
  await context.close();
}

// ---- 4. Presets apply their values, and Back to the published site restores the defaults. ----
{
  const { context, page } = await open("tuner.html");
  await page.click("text=Bold");
  await settle(page, 300);
  const bold = await page.evaluate(() => ({ step: document.querySelector("#k-step").value, pitch: document.querySelector("#k-pitch").value }));
  check("presets.bold-sets-its-spacing-and-grid", bold.step === "9" && bold.pitch === "10", bold);
  await page.click("#reset");
  await settle(page, 300);
  const back = await page.evaluate(() => ({ step: document.querySelector("#k-step").value, pitch: document.querySelector("#k-pitch").value, bg: document.querySelector("#k-bg").value }));
  check("presets.reset-restores-the-published-site", back.step === "11" && back.pitch === "8" && back.bg.toUpperCase() === "#0B0B0C", back);
  await context.close();
}

// ---- 5. Keep these values: the text copies out and pastes back, and text that is not settings is refused. ----
{
  const { context, page } = await open("tuner.html");
  await page.click("#copy-json");
  await settle(page, 200);
  const exported = await page.inputValue("#io");
  const parsed = JSON.parse(exported);
  check("io.export-holds-every-value", parsed.step === 11 && parsed.pitch === 8 && parsed.zoom === 8 && parsed.glide === 0.69 && parsed.route.length === 5, { keys: Object.keys(parsed) });
  await page.fill("#k-step", "20");
  await page.dispatchEvent("#k-step", "input");
  await settle(page, 200);
  await page.fill("#io", exported);
  await page.click("#apply-json");
  await settle(page, 300);
  const restored = await page.evaluate(() => document.querySelector("#k-step").value);
  check("io.paste-restores-the-values", restored === "11", { step: restored });
  await page.fill("#io", "not settings");
  await page.click("#apply-json");
  await settle(page, 200);
  const message = await page.textContent("#io-message");
  check("io.text-that-is-not-settings-is-refused", message.startsWith("That text is not settings"), { message });
  await context.close();
}

// ---- 6. Autoplay moves the page down the route, and the scrub bar moves it by hand. ----
{
  const { context, page } = await open("tuner.html");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await settle(page, 200);
  await page.click("#play");
  await settle(page, 1200);
  const moved = await page.evaluate(() => window.scrollY);
  await page.click("#play");
  check("playback.autoplay-moves-down-the-route", moved > 300, { scrollY: moved });
  await page.fill("#scrub", "2");
  await page.dispatchEvent("#scrub", "input");
  await settle(page, 500);
  const scrubbed = await page.evaluate(() => window.scrollY / window.innerHeight);
  check("playback.scrub-moves-to-the-chosen-stop", Math.abs(scrubbed - 2) < 0.05, { position: scrubbed });
  await context.close();
}

// ---- 7. Reduced motion holds the map still, as on the site. ----
{
  const { context, page } = await open("tuner.html", 1440, 900, { reduced: true });
  await page.evaluate(() => window.scrollTo({ top: window.innerHeight * 2, behavior: "instant" }));
  await page.waitForTimeout(60);
  const early = await mapDigest(page);
  await settle(page, 900);
  const late = await mapDigest(page);
  check("motion.reduced-holds-the-map-still", early.hash === late.hash, { early: early.hash, late: late.hash });
  await context.close();
}

// ---- 8. No sideways scroll on the page or in the drawer, at phone width. ----
{
  const { context, page, errors } = await open("tuner.html", 390, 844);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("layout.no-sideways-scroll.phone", sideways <= 0, { sideways });
  check("layout.phone-no-console-errors", errors.length === 0, errors);
  await context.close();
}

// ---- 9. The settings the owner chose are the site's defaults: pasted into the simulator they come back out unchanged, and the map they
//      draw is the published site's map. ----
const OWNER_SETTINGS = {
  bg: "#0B0B0C", line: "#1C1C1F", money: "#F5C518", meridian: "#FF2E38", meridianOn: true, meridianOpacity: 0.7,
  pitch: 8, block: 1, sharp: 2, step: 11, jitter: 0.3, zoom: 8, glide: 0.69,
  grainOn: true, grain: 0.07, billBand: 0.6, billCurve: "smoothstep", billPrint: 24,
  route: [47, 23, 0, -23, -41], snap: true, speed: 0.5,
};
{
  const site = await open("index.html");
  await site.page.evaluate(() => window.scrollTo({ top: window.innerHeight, behavior: "instant" }));
  const siteDigest = await settledDigest(site.page);
  await site.context.close();

  const { context, page } = await open("tuner.html");
  await page.fill("#io", JSON.stringify(OWNER_SETTINGS, null, 2));
  await page.click("#apply-json");
  await settle(page, 300);
  await page.click("#copy-json");
  await settle(page, 200);
  const roundTrip = JSON.parse(await page.inputValue("#io"));
  const differs = Object.keys(OWNER_SETTINGS).filter((k) => JSON.stringify(roundTrip[k]) !== JSON.stringify(OWNER_SETTINGS[k]));
  check("owner-settings.round-trip-through-the-simulator", differs.length === 0, { differs });
  await page.evaluate(() => window.scrollTo({ top: window.innerHeight, behavior: "instant" }));
  const pastedDigest = await settledDigest(page);
  check("owner-settings.draw-the-published-site", pastedDigest.hash === siteDigest.hash, { site: siteDigest.hash, pasted: pastedDigest.hash });
  await context.close();
}

// ---- Screenshots: the simulator at its defaults, and with two presets applied. ----
{
  const { context, page } = await open("tuner.html");
  await page.evaluate(() => window.scrollTo({ top: window.innerHeight, behavior: "instant" }));
  await settle(page, 1200);
  await page.screenshot({ path: join(out, "defaults.png") });
  await page.click("text=Paper");
  await settle(page, 900);
  await page.screenshot({ path: join(out, "paper.png") });
  await page.click("text=Bold");
  await settle(page, 900);
  await page.screenshot({ path: join(out, "bold.png") });
  await context.close();
}

writeFileSync(join(here, "tuner-measurements.json"), JSON.stringify({ url: "served from docs/design/prototype/meridian-map", results }, null, 2));
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
