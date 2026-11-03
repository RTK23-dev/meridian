// The site background behind the walkthrough: the same map as the site, drawn by the same halftone, with the same grain. The walkthrough
// does not scroll, so the map follows the screen on show instead: each group of screens sits at the site's stop of the same name, and
// the map glides to it when the walkthrough moves into that group. Home sits with Start, and States and Overlay keep the place the
// walkthrough was last at, because they are shown from another screen.
import { WORLD_FIELD } from "./meridian-map/world-field.mjs";
import { ROUTE, GLIDE, decodeField } from "./meridian-map/map-model.mjs";
import { HALFTONE_DEFAULTS, drawHalftone } from "./meridian-map/halftone.mjs";

const STOP_FOR_GROUP = Object.freeze({ Start: "cover", Home: "cover", Create: "create", Library: "library", Insights: "insights", Settings: "settings" });
const LAT_FOR_STOP = Object.freeze(Object.fromEntries(ROUTE.map((stop) => [stop.id, stop.lat])));

// The latitude a group of screens sits at. A group with no stop of its own gives back the fallback, so the map holds still.
export function latitudeForGroup(group, fallback) {
  const stop = STOP_FOR_GROUP[group];
  return stop === undefined ? fallback : LAT_FOR_STOP[stop];
}

// The grain: a static speckle tile, laid over the page at low opacity. It does not move, as on the site.
function makeGrain(layer) {
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
  layer.style.backgroundImage = `url(${tile.toDataURL()})`;
  layer.style.backgroundSize = "160px 160px";
}

// Starts the background on the canvas, and returns a way to move it: `follow(group)` sends the map to the group's stop.
export function startBackground(canvas, grainLayer) {
  const root = document.documentElement;
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const field = decodeField(WORLD_FIELD.bits);
  let palette = null;
  let version = 0;
  let lastKey = "";
  let target = ROUTE[0].lat;
  let current = target;

  // The ground and the line come from the page's tokens, so the background follows the theme.
  function readPalette() {
    const style = getComputedStyle(root);
    palette = { bg: style.getPropertyValue("--map-bg").trim(), line: style.getPropertyValue("--map-line").trim() };
    version += 1;
  }
  // The canvas is sized to the window at the screen's pixel density, so every block is drawn sharp.
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    version += 1;
  }
  function frame() {
    current = reduce.matches ? target : current + (target - current) * GLIDE;
    if (Math.abs(target - current) < 1e-4) current = target;
    const key = `${current.toFixed(3)}|${version}|${innerWidth}x${innerHeight}`;
    if (key !== lastKey) {
      drawHalftone(ctx, field, { width: innerWidth, height: innerHeight, centreLat: current, zoom: HALFTONE_DEFAULTS.zoom }, HALFTONE_DEFAULTS, palette);
      lastKey = key;
    }
    requestAnimationFrame(frame);
  }

  readPalette();
  sizeCanvas();
  makeGrain(grainLayer);
  window.addEventListener("resize", sizeCanvas);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", readPalette);
  new MutationObserver(readPalette).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  requestAnimationFrame(frame);

  return {
    follow(group) {
      target = latitudeForGroup(group, target);
    },
  };
}
