// The simulator: the site background, drawn by the same rules, with every value open to change. At the defaults it draws the same pixels as
// the published site, because both draw through halftone.mjs. Changes are kept on this device, and can be copied out as JSON or as a
// settings object, and pasted back in.
import { WORLD_FIELD } from "./world-field.mjs";
import { ROUTE, GLIDE, latitudeAt, decodeField, billWeight, BAYER4, printed, printFractionFor, PRINT_CURVES } from "./map-model.mjs";
import { HALFTONE_DEFAULTS, drawHalftone } from "./halftone.mjs";

const DEFAULTS = Object.freeze({
  bg: "#0B0B0C", line: "#1C1C1F", money: "#F5C518", meridian: "#FF2E38", meridianOn: true, meridianOpacity: 0.7,
  ...HALFTONE_DEFAULTS, glide: GLIDE,
  grainOn: true, grain: 0.07,
  billBand: 0.6, billCurve: "smoothstep", billPrint: 24,
  route: [47, 23, 0, -23, -41],
  snap: true, speed: 0.5,
});
const PRESETS = Object.freeze({
  "As published": {},
  Quiet: { line: "#161618", grain: 0.04, step: 16, block: 0.75, jitter: 0.06, meridianOpacity: 0.5 },
  Bold: { line: "#2A2A2F", grain: 0.12, step: 9, pitch: 10, block: 0.95, sharp: 3, zoom: 12 },
  Coarse: { pitch: 12, zoom: 16, step: 18 },
  Paper: { bg: "#F4F4F2", line: "#DCDCD7", money: "#D9A400", meridian: "#C8102E", grain: 0.05 },
  "Slow glide": { glide: 0.04, speed: 0.2 },
});
const STORE_KEY = "meridian-map-tuner";
const STOP_NAMES = ["Start", "Create", "Library", "Insights", "Settings"];

// The controls, in the order the drawer shows them. Ranges are checked and rounded to their step whenever a value is set.
const SPEC = [
  { group: "Colour", items: [
    { key: "bg", type: "color", label: "Ground" },
    { key: "line", type: "color", label: "Block colour" },
    { key: "money", type: "color", label: "Bill yellow" },
    { key: "meridian", type: "color", label: "Meridian line" },
    { key: "meridianOn", type: "bool", label: "Show the meridian" },
    { key: "meridianOpacity", type: "range", min: 0, max: 1, step: 0.05, label: "Meridian opacity" },
    { key: "grainOn", type: "bool", label: "Grain" },
    { key: "grain", type: "range", min: 0, max: 0.25, step: 0.01, label: "Grain strength" },
  ] },
  { group: "Map", items: [
    { key: "step", type: "range", min: 2, max: 24, step: 1, label: "Contour spacing (cells)", help: "A cell is half a degree. 12 is the published site." },
    { key: "pitch", type: "range", min: 3, max: 14, step: 1, label: "Grid spacing (screen px)", help: "The distance between block centres. 6 is the published site." },
    { key: "block", type: "range", min: 0.3, max: 1, step: 0.05, label: "Largest block (share of the grid)", help: "How much of its grid cell the darkest block fills." },
    { key: "sharp", type: "range", min: 0.5, max: 4, step: 0.25, label: "Band sharpness", help: "Higher values make each band narrower, with more ground between bands." },
    { key: "jitter", type: "range", min: 0, max: 0.3, step: 0.01, label: "Opacity variation between blocks" },
    { key: "zoom", type: "range", min: 4, max: 24, step: 1, label: "Zoom (px per degree)", help: "The map is centred on the meridian. 8 is the published site." },
  ] },
  { group: "Motion", items: [
    { key: "glide", type: "range", min: 0.02, max: 1, step: 0.01, label: "Glide (how fast the map follows)" },
    { key: "snap", type: "bool", label: "Snap to each screen" },
    { key: "speed", type: "range", min: 0.1, max: 2, step: 0.05, label: "Autoplay speed (screens per second)" },
  ] },
  { group: "Bills", items: [
    { key: "billBand", type: "range", min: 0.2, max: 1, step: 0.05, label: "Print band (share of the screen)", help: "How far from the middle a bill starts to fade." },
    { key: "billCurve", type: "select", options: PRINT_CURVES, label: "Print curve" },
    { key: "billPrint", type: "range", min: 6, max: 48, step: 1, label: "Print steps" },
  ] },
];
const FLAT = Object.fromEntries(SPEC.flatMap((g) => g.items).map((item) => [item.key, item]));

// ---- Values: checked on every change, so nothing outside its range or of the wrong kind can reach the drawing. ----
const round = (value, step) => Number((Math.round(value / step) * step).toFixed(4));
function normal(key, value) {
  if (key === "route") {
    if (!Array.isArray(value) || value.length !== 5) return DEFAULTS.route.slice();
    return value.map((v) => Math.min(90, Math.max(-90, round(Number(v), 0.5))));
  }
  const spec = FLAT[key];
  if (!spec) return undefined;
  if (spec.type === "bool") return Boolean(value);
  if (spec.type === "color") return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toUpperCase() : DEFAULTS[key];
  if (spec.type === "select") return spec.options.includes(value) ? value : DEFAULTS[key];
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS[key];
  return round(Math.min(spec.max, Math.max(spec.min, n)), spec.step);
}
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    return saved && typeof saved === "object" ? saved : null;
  } catch {
    return null;
  }
}
function save(settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be refused. The settings still apply, and last until the page is closed.
  }
}
const settings = {};
for (const key of Object.keys(DEFAULTS)) settings[key] = normal(key, (load() ?? {})[key] ?? DEFAULTS[key]);

function start() {
  const root = document.documentElement;
  const canvas = document.querySelector("#map");
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const field = decodeField(WORLD_FIELD.bits);
  const navLinks = [...document.querySelectorAll(".route a[data-stop]")];
  const meridianEl = document.querySelector(".meridian");
  const grainEl = document.querySelector(".grain");
  const stopCount = ROUTE.length;

  // ---- The palette, as the page's own colours, so the text, the rules and the map follow one set. ----
  const hex = (value) => {
    const n = parseInt(value.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  // The text follows the ground: dark text on a light ground, light text on a dark one, whatever the system theme is.
  const brightness = (value) => {
    const [r, g, b] = hex(value).map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // Every change to the drawing bumps `version`, so the map is drawn again on the next frame.
  let version = 0;
  let palette = null;
  function applyPalette() {
    palette = { bg: settings.bg, line: settings.line, money: settings.money, moneyRgb: hex(settings.money) };
    const light = brightness(settings.bg) > 0.4;
    root.style.setProperty("--map-bg", settings.bg);
    root.style.setProperty("--map-line", settings.line);
    root.style.setProperty("--money", settings.money);
    root.style.setProperty("--fg", light ? "#0A0A0A" : "#F2F2F2");
    root.style.setProperty("--muted", light ? "#4A4A4A" : "#A3A3A3");
    root.style.setProperty("--rule", light ? "#CFCFCA" : "#2A2A2D");
    root.style.colorScheme = light ? "light" : "dark";
    for (const b of bills) b.last = -1;
    version += 1;
  }

  // ---- The map: a halftone at full resolution, the canvas sized to the window at the screen's pixel density. ----
  let stats = { blocks: 0, coverage: 0 };
  let lastKey = "";
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    version += 1;
  }

  // ---- The bills. ----
  const bills = [...document.querySelectorAll("canvas.bill")].map((el) => {
    const w = el.width;
    const h = el.height;
    const weights = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) weights[y * w + x] = billWeight(x, y, w, h);
    const billCtx = el.getContext("2d");
    return { el, ctx: billCtx, w, h, weights, image: billCtx.createImageData(w, h), last: -1 };
  });
  function drawBill(b, amount) {
    const d = b.image.data;
    for (let y = 0; y < b.h; y += 1) {
      for (let x = 0; x < b.w; x += 1) {
        const i = y * b.w + x;
        const k = i * 4;
        if (printed(BAYER4[(y & 3) * 4 + (x & 3)], amount, b.weights[i])) {
          d[k] = palette.moneyRgb[0];
          d[k + 1] = palette.moneyRgb[1];
          d[k + 2] = palette.moneyRgb[2];
          d[k + 3] = 255;
        } else {
          d[k + 3] = 0;
        }
      }
    }
    b.ctx.putImageData(b.image, 0, 0);
  }
  const printAmount = (b) => {
    const rect = b.el.getBoundingClientRect();
    const raw = printFractionFor(rect.top + rect.height / 2, innerHeight, settings.billBand, settings.billCurve);
    return Math.round(raw * settings.billPrint) / settings.billPrint;
  };

  // ---- The grain tile, made once. Its strength is the layer's opacity. ----
  function makeGrain() {
    const tile = document.createElement("canvas");
    tile.width = 160;
    tile.height = 160;
    const g = tile.getContext("2d");
    const img = g.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() < 0.5 ? 0 : 255;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grainEl.style.backgroundImage = `url(${tile.toDataURL()})`;
    grainEl.style.backgroundSize = "160px 160px";
  }
  function applyGrain() {
    grainEl.style.opacity = settings.grainOn ? String(settings.grain) : "0";
  }
  function applyMeridian() {
    meridianEl.style.display = settings.meridianOn ? "" : "none";
    meridianEl.style.background = settings.meridian;
    meridianEl.style.opacity = String(settings.meridianOpacity);
  }
  function applySnap() {
    root.style.scrollSnapType = settings.snap && !playing && !scrubbing ? "y mandatory" : "none";
  }

  // ---- The route and the position. The loop works as on the site: a swipe past the loop screen lands on the first stop, and the map is
  //      the same picture, because a half turn of the map is the same part of the world. ----
  const routeLats = () => [...settings.route, settings.route[0] - 180];
  let current = settings.route[0];
  let playing = false;
  let scrubbing = false;
  const progress = () => window.scrollY / Math.max(1, innerHeight);
  const toScroll = (p) => window.scrollTo({ top: p * innerHeight, behavior: "instant" });
  window.addEventListener("scroll", () => {
    if (window.scrollY >= stopCount * innerHeight - 1) {
      window.scrollTo({ top: window.scrollY - stopCount * innerHeight, behavior: "instant" });
      current = latitudeAt(progress(), routeLats());
    }
  }, { passive: true });

  // ---- The frame: glide the map toward the position, redraw what changed, and keep the readout current. ----
  let frames = 0;
  let fps = 0;
  let fpsSince = performance.now();
  let lastTime = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    frames += 1;
    if (now - fpsSince >= 1000) {
      fps = Math.round((frames * 1000) / (now - fpsSince));
      frames = 0;
      fpsSince = now;
    }
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    if (playing) {
      let p = progress() + settings.speed * dt;
      if (p >= stopCount) p -= stopCount;
      toScroll(p);
    }
    const p = progress();
    const target = latitudeAt(p, routeLats());
    current = reduce.matches ? target : current + (target - current) * settings.glide;
    if (Math.abs(target - current) < 1e-4) current = target;
    const key = `${current.toFixed(3)}|${version}|${innerWidth}x${innerHeight}`;
    if (key !== lastKey) {
      stats = drawHalftone(ctx, field, { width: innerWidth, height: innerHeight, centreLat: current, zoom: settings.zoom }, settings, palette);
      lastKey = key;
    }
    for (const b of bills) {
      const amount = printAmount(b);
      if (amount !== b.last) {
        drawBill(b, amount);
        b.last = amount;
      }
    }
    const here = Math.round(p) % stopCount;
    navLinks.forEach((link, i) => link.setAttribute("aria-current", String(i === here)));
    readout(p, current);
  }

  // ---- The readout: where the page is, which stop, the latitude, how much of the window is ink, and how many blocks are drawn. ----
  const out = {
    stop: document.querySelector("#r-stop"),
    lat: document.querySelector("#r-lat"),
    position: document.querySelector("#r-position"),
    bill: document.querySelector("#r-bill"),
    coverage: document.querySelector("#r-coverage"),
    blocks: document.querySelector("#r-blocks"),
    fps: document.querySelector("#r-fps"),
  };
  let readAt = 0;
  function readout(p, lat) {
    if (performance.now() - readAt < 150) return;
    readAt = performance.now();
    const here = Math.round(p) % stopCount;
    out.stop.textContent = `${here + 1} · ${STOP_NAMES[here]}`;
    out.lat.textContent = `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? "N" : "S"}`;
    out.position.textContent = `${p.toFixed(2)} of ${stopCount}`;
    out.bill.textContent = `${Math.round(printAmount(bills[Math.min(bills.length - 1, here)]) * 100)}% printed`;
    out.coverage.textContent = `${(stats.coverage * 100).toFixed(1)}% of the window`;
    out.blocks.textContent = `${stats.blocks.toLocaleString("en-GB")} blocks`;
    out.fps.textContent = `${fps} fps`;
  }

  // ---- The drawer: one control for each value, built from the spec, and kept in step with the settings. ----
  const drawerBody = document.querySelector("#controls");
  function buildControls() {
    const html = SPEC.map((group) => `<fieldset class="group"><legend>${group.group}</legend>${group.items.map(controlHtml).join("")}</fieldset>`).join("");
    const route = `<fieldset class="group"><legend>Route (latitude of each screen)</legend>${STOP_NAMES.map((name, i) => `
      <label class="row"><span>${i + 1}. ${name}</span><input type="number" id="k-route-${i}" min="-90" max="90" step="0.5" data-route="${i}"></label>`).join("")}
      <p class="help">The loop screen is the first one a half turn of the map on, so it moves with the first.</p></fieldset>`;
    drawerBody.innerHTML = html + route;
    for (const group of SPEC) {
      for (const item of group.items) {
        const el = document.querySelector(`#k-${item.key}`);
        el.addEventListener("input", () => setValue(item.key, item.type === "bool" ? el.checked : el.value));
      }
    }
    for (const el of drawerBody.querySelectorAll("[data-route]")) {
      el.addEventListener("change", () => {
        const route = settings.route.slice();
        route[Number(el.dataset.route)] = el.value;
        setValue("route", route);
      });
    }
    syncControls();
  }
  function controlHtml(item) {
    const id = `k-${item.key}`;
    const help = item.help ? `<p class="help">${item.help}</p>` : "";
    if (item.type === "bool") return `<label class="row"><span>${item.label}</span><input type="checkbox" id="${id}"></label>${help}`;
    if (item.type === "color") return `<label class="row"><span>${item.label}</span><input type="color" id="${id}"></label>`;
    if (item.type === "select") return `<label class="row"><span>${item.label}</span><select id="${id}">${item.options.map((o) => `<option value="${o}">${o}</option>`).join("")}</select></label>${help}`;
    return `<label class="row"><span>${item.label} <output id="o-${item.key}"></output></span><input type="range" id="${id}" min="${item.min}" max="${item.max}" step="${item.step}"></label>${help}`;
  }
  function syncControls() {
    for (const group of SPEC) {
      for (const item of group.items) {
        const el = document.querySelector(`#k-${item.key}`);
        if (item.type === "bool") el.checked = settings[item.key];
        else el.value = String(settings[item.key]);
        const output = document.querySelector(`#o-${item.key}`);
        if (output) output.textContent = String(settings[item.key]);
      }
    }
    settings.route.forEach((lat, i) => { document.querySelector(`#k-route-${i}`).value = String(lat); });
  }

  // ---- A value changes: check it, keep it, apply what it touches, and save. ----
  function setValue(key, value) {
    settings[key] = normal(key, value);
    save(settings);
    if (["bg", "line", "money"].includes(key)) applyPalette();
    version += 1;
    if (key === "meridian" || key === "meridianOn" || key === "meridianOpacity") applyMeridian();
    if (key === "grain" || key === "grainOn") applyGrain();
    if (key === "snap") applySnap();
    if (key === "billBand" || key === "billCurve" || key === "billPrint") for (const b of bills) b.last = -1;
    syncControls();
  }
  function applyAll(next) {
    for (const key of Object.keys(DEFAULTS)) settings[key] = normal(key, next[key] ?? DEFAULTS[key]);
    save(settings);
    applyPalette();
    version += 1;
    applyMeridian();
    applyGrain();
    applySnap();
    syncControls();
  }

  // ---- Presets, export and import. ----
  const exportText = document.querySelector("#io");
  const message = document.querySelector("#io-message");
  const say = (text) => { message.textContent = text; };
  for (const [name, values] of Object.entries(PRESETS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = name;
    button.addEventListener("click", () => {
      applyAll({ ...DEFAULTS, ...values });
      say(`Applied “${name}”.`);
    });
    document.querySelector("#presets").append(button);
  }
  function settingsJSON() {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) out[key] = settings[key];
    return JSON.stringify(out, null, 2);
  }
  document.querySelector("#copy-json").addEventListener("click", async () => {
    exportText.value = settingsJSON();
    try {
      await navigator.clipboard.writeText(exportText.value);
      say("Copied. Paste it back below to restore these values.");
    } catch {
      exportText.select();
      say("The browser would not copy. The text is selected: copy it with Ctrl or Cmd C.");
    }
  });
  document.querySelector("#copy-code").addEventListener("click", async () => {
    exportText.value = `// Settings from the simulator. The grid values go in HALFTONE_DEFAULTS in halftone.mjs, and the colours go in :root in site.css.\nexport const SETTINGS = ${settingsJSON()};\n`;
    try {
      await navigator.clipboard.writeText(exportText.value);
      say("Copied as a settings object.");
    } catch {
      exportText.select();
      say("The browser would not copy. The text is selected: copy it with Ctrl or Cmd C.");
    }
  });
  document.querySelector("#apply-json").addEventListener("click", () => {
    try {
      const parsed = JSON.parse(exportText.value.replace(/^\/\/.*$/gm, "").trim().replace(/^export const SETTINGS = /, "").replace(/;$/, ""));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      applyAll({ ...DEFAULTS, ...parsed });
      say("Applied the pasted settings. Anything missing kept its default.");
    } catch {
      say("That text is not settings. Paste the JSON from Copy JSON, or the object from Copy as code.");
    }
  });
  document.querySelector("#reset").addEventListener("click", () => {
    applyAll(DEFAULTS);
    say("Back to the published site.");
  });

  // ---- Playback: autoplay along the route, and a scrub bar that sets the position by hand. ----
  const scrub = document.querySelector("#scrub");
  scrub.max = String(stopCount - 0.01);
  scrub.addEventListener("pointerdown", () => { scrubbing = true; playing = false; applySnap(); setPlayLabel(); });
  scrub.addEventListener("input", () => { toScroll(Number(scrub.value)); });
  scrub.addEventListener("pointerup", () => { scrubbing = false; applySnap(); });
  const playButton = document.querySelector("#play");
  function setPlayLabel() { playButton.textContent = playing ? "Pause" : "Play the route"; playButton.setAttribute("aria-pressed", String(playing)); }
  playButton.addEventListener("click", () => {
    playing = !playing;
    applySnap();
    setPlayLabel();
  });
  const updateScrub = () => { if (!scrubbing) scrub.value = String(Math.min(Number(scrub.max), progress())); };
  setInterval(updateScrub, 120);

  // ---- The drawer, which folds away so the page can be seen whole. ----
  const toggle = document.querySelector("#drawer-toggle");
  const drawer = document.querySelector("#drawer");
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    drawer.dataset.open = String(open);
  });

  // ---- Start. ----
  buildControls();
  applyPalette();
  sizeCanvas();
  makeGrain();
  applyGrain();
  applyMeridian();
  applySnap();
  setPlayLabel();
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyPalette());
  window.addEventListener("resize", () => sizeCanvas());
  requestAnimationFrame(frame);
}

start();
