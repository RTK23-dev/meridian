// The site: a depth map behind every screen, drawn one 4 px cell at a time, and the yellow bills printed by dither. The map follows the
// scroll position down the meridian; the bills print more as they reach the middle of the screen. Pure rules are in map-model.mjs.
import { WORLD_LINES } from "./world-lines.mjs";
import { ROUTE, CELL_DEG, CELL_PX, loopLatitudes, latitudeAt, sampleIndex, decodeBits, lineAt, BAYER4, billWeight, printed, printFraction } from "./map-model.mjs";

function start() {
  const root = document.documentElement;
  const canvas = document.querySelector("#map");
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const bits = decodeBits(WORLD_LINES.bits);
  const lats = loopLatitudes();
  const loopTop = ROUTE.length; // the screen index of the loop screen, which is the last one
  const navLinks = [...document.querySelectorAll(".route a[data-stop]")];

  // ---- Colours: read from the page's tokens, so the map follows the theme and the page's own colours. ----
  const hex = (value) => {
    const n = parseInt(value.trim().slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  let palette = null;
  function readPalette() {
    const style = getComputedStyle(root);
    const bg = hex(style.getPropertyValue("--map-bg"));
    const line = hex(style.getPropertyValue("--map-line"));
    const money = hex(style.getPropertyValue("--money"));
    palette = { bg, line, money, key: [...bg, ...line, ...money].join(",") };
    for (const b of bills) b.last = -1;
  }

  // ---- The map canvas: one canvas pixel per screen cell, scaled up with no smoothing, so every cell is a crisp square. ----
  let cols = 0;
  let rows = 0;
  let image = null;
  let lastKey = "";
  function sizeMap() {
    cols = Math.ceil(innerWidth / CELL_PX);
    rows = Math.ceil(innerHeight / CELL_PX);
    canvas.width = cols;
    canvas.height = rows;
    canvas.style.width = `${cols * CELL_PX}px`;
    canvas.style.height = `${rows * CELL_PX}px`;
    image = ctx.createImageData(cols, rows);
    lastKey = "";
  }
  function drawMap(latC) {
    const d = image.data;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const rgb = lineAt(bits, sampleIndex(c, r, latC, cols, rows)) ? palette.line : palette.bg;
        const k = (r * cols + c) * 4;
        d[k] = rgb[0];
        d[k + 1] = rgb[1];
        d[k + 2] = rgb[2];
        d[k + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
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
          d[k] = palette.money[0];
          d[k + 1] = palette.money[1];
          d[k + 2] = palette.money[2];
          d[k + 3] = 255;
        } else {
          d[k + 3] = 0;
        }
      }
    }
    b.ctx.putImageData(b.image, 0, 0);
  }

  // ---- The grain: a static speckle tile, laid over the page at low opacity. It does not move, so it never competes with the content. ----
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
  function progress() {
    return window.scrollY / Math.max(1, innerHeight);
  }
  window.addEventListener("scroll", () => {
    if (window.scrollY >= loopTop * innerHeight - 1) {
      window.scrollTo({ top: window.scrollY - loopTop * innerHeight, behavior: "instant" });
      current = latitudeAt(progress(), lats);
    }
  }, { passive: true });

  // ---- The frame: glide the map toward the scroll's latitude (at once for reduced motion), redraw the map and the bills when they change,
  //      and mark the stop the page is on. ----
  function frame() {
    const p = progress();
    target = latitudeAt(p, lats);
    current = reduce.matches ? target : current + (target - current) * 0.14;
    if (Math.abs(target - current) < 1e-4) current = target;
    const latQ = Math.round(current / CELL_DEG) * CELL_DEG;
    const key = `${latQ}|${cols}|${rows}|${palette.key}`;
    if (key !== lastKey) {
      drawMap(latQ);
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

  // ---- Start: size the map, read the palette, lay the grain, and follow the theme and the window's size. ----
  readPalette();
  sizeMap();
  grain();
  window.addEventListener("resize", () => { sizeMap(); });
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", readPalette);
  new MutationObserver(readPalette).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  requestAnimationFrame(frame);
}

start();
