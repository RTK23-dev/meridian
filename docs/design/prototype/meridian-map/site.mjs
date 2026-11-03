// The site: the background as a square halftone of the depth map, drawn at full resolution, with the yellow bills printed by dither. The map
// follows the scroll position down the meridian. The drawing is shared with the simulator through halftone.mjs.
import { WORLD_FIELD } from "./world-field.mjs";
import { ROUTE, loopLatitudes, latitudeAt, decodeField, BAYER4, billWeight, printed, printFraction } from "./map-model.mjs";
import { HALFTONE_DEFAULTS, drawHalftone } from "./halftone.mjs";

function start() {
  const root = document.documentElement;
  const canvas = document.querySelector("#map");
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const field = decodeField(WORLD_FIELD.bits);
  const lats = loopLatitudes();
  const loopTop = ROUTE.length;
  const navLinks = [...document.querySelectorAll(".route a[data-stop]")];
  const style = HALFTONE_DEFAULTS;

  // ---- Colours: read from the page's tokens, so the background follows the theme. ----
  const rgb = (value) => {
    const n = parseInt(value.trim().slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  let palette = null;
  function readPalette() {
    const computed = getComputedStyle(root);
    const bg = computed.getPropertyValue("--map-bg").trim();
    const line = computed.getPropertyValue("--map-line").trim();
    const money = computed.getPropertyValue("--money").trim();
    palette = { bg, line, money, moneyRgb: rgb(money), key: `${bg}|${line}|${money}` };
    for (const b of bills) b.last = -1;
  }

  // ---- The canvas: sized to the window at the screen's pixel density, so every block is drawn sharp. ----
  let lastKey = "";
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lastKey = "";
  }

  // ---- The bills: each has a weight for every dot, and is printed by an ordered dither at the amount set by its place on screen. ----
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

  // ---- The grain: a static speckle tile, laid over the page at low opacity. It does not move. ----
  function grain() {
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
    const layer = document.querySelector(".grain");
    layer.style.backgroundImage = `url(${tile.toDataURL()})`;
    layer.style.backgroundSize = "160px 160px";
  }

  // ---- The loop: a swipe past the last screen lands on the loop screen, which shows the first stop's part of the map. The jump back to the
  //      first screen changes nothing on the map, because a half turn of the map is the same picture. ----
  let current = lats[0];
  let target = lats[0];
  const progress = () => window.scrollY / Math.max(1, innerHeight);
  window.addEventListener("scroll", () => {
    if (window.scrollY >= loopTop * innerHeight - 1) {
      window.scrollTo({ top: window.scrollY - loopTop * innerHeight, behavior: "instant" });
      current = latitudeAt(progress(), lats);
    }
  }, { passive: true });

  // ---- The frame: glide the map toward the scroll's latitude (at once for reduced motion), redraw the background and the bills when they
  //      change, and mark the stop the page is on. ----
  function frame() {
    const p = progress();
    target = latitudeAt(p, lats);
    current = reduce.matches ? target : current + (target - current) * 0.14;
    if (Math.abs(target - current) < 1e-4) current = target;
    const key = `${current.toFixed(3)}|${palette.key}|${innerWidth}x${innerHeight}`;
    if (key !== lastKey) {
      drawHalftone(ctx, field, { width: innerWidth, height: innerHeight, centreLat: current, zoom: style.zoom }, style, palette);
      lastKey = key;
    }
    for (const b of bills) {
      const rect = b.el.getBoundingClientRect();
      const amount = Math.round(printFraction(rect.top + rect.height / 2, innerHeight) * 24) / 24;
      if (amount !== b.last) {
        drawBill(b, amount);
        b.last = amount;
      }
    }
    const here = Math.round(p) % ROUTE.length;
    navLinks.forEach((link, i) => link.setAttribute("aria-current", String(i === here)));
    requestAnimationFrame(frame);
  }

  // ---- Start: size the canvas, read the palette, lay the grain, and follow the theme and the window's size. ----
  readPalette();
  sizeCanvas();
  grain();
  window.addEventListener("resize", () => { sizeCanvas(); });
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", readPalette);
  new MutationObserver(readPalette).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  requestAnimationFrame(frame);
}

start();
