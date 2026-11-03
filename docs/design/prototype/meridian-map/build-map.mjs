// Builds the depth map the site background draws. It reads a TopoJSON land outline (world-atlas, Natural Earth, public domain), fills it
// into a grid of 0.5 degree cells, measures every cell's distance from the coast, and keeps only the lines: the coastline, and a contour
// line every `step` cells inland and out at sea. Those lines are the depth map. The output stores one bit per cell, packed as base64.
//
// Usage: node build-map.mjs <land-110m.json> <out.mjs> [step]
//   land-110m.json: world-atlas@2.0.2/land-110m.json, fetched from https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json
//   step: contour spacing in cells (default 3, which is 1.5 degrees, or 12 px at 8 px per degree with 4 px cells).
import { readFileSync, writeFileSync } from "node:fs";

const [input, output, stepArg] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node build-map.mjs <land-110m.json> <out.mjs> [step]");
  process.exit(2);
}
const STEP = Number(stepArg ?? 3);
const W = 720;
const H = 360;
const CELL = 0.5; // degrees per cell: 720 cells across 360 degrees, 360 rows across 180 degrees.

const topo = JSON.parse(readFileSync(input, "utf8"));
if (topo.type !== "Topology") throw new Error("expected a TopoJSON topology");

// ---- Decode the arcs: positions are quantised and delta-encoded, so each arc is walked from its first point. ----
const { scale, translate } = topo.transform;
const arcs = topo.arcs.map((arc) => {
  let x = 0;
  let y = 0;
  return arc.map(([dx, dy]) => {
    x += dx;
    y += dy;
    return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
  });
});
const ringOf = (indices) => {
  const points = [];
  for (const index of indices) {
    const arc = index >= 0 ? arcs[index] : arcs[~index].slice().reverse();
    points.push(...(points.length ? arc.slice(1) : arc));
  }
  return points;
};
const geometry = topo.objects.land.geometries[0];
if (geometry.type !== "MultiPolygon") throw new Error("expected a MultiPolygon land geometry");
const rings = geometry.arcs.flatMap((polygon) => polygon.map(ringOf));

// ---- Fill the land by scanline: at each row's centre latitude, find where the rings cross, and fill between pairs (even-odd). ----
const edges = [];
for (const ring of rings) {
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    if (y1 !== y2) edges.push([x1, y1, x2, y2]);
  }
}
const land = new Uint8Array(W * H);
for (let row = 0; row < H; row += 1) {
  const lat = 90 - (row + 0.5) * CELL;
  const xs = [];
  for (const [x1, y1, x2, y2] of edges) {
    if ((y1 > lat) !== (y2 > lat)) xs.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
  }
  xs.sort((a, b) => a - b);
  for (let k = 0; k + 1 < xs.length; k += 2) {
    for (let col = 0; col < W; col += 1) {
      const lon = -180 + (col + 0.5) * CELL;
      if (lon >= xs[k] && lon < xs[k + 1]) land[row * W + col] = 1;
    }
  }
}

// ---- Distance from the coast, in cells, by a two-pass chamfer. Land cells measure to sea and sea cells to land. ----
const SQRT2 = Math.SQRT2;
function distanceTo(target) {
  const d = new Float32Array(W * H).fill(1e9);
  for (let i = 0; i < W * H; i += 1) if (land[i] === target) d[i] = 0;
  const pass = (rows, cols, dr, dc) => {
    for (const r of rows) {
      for (const c of cols) {
        const i = r * W + c;
        let best = d[i];
        for (const [nr, nc, w] of [[r + dr, c, 1], [r, c + dc, 1], [r + dr, c + dc, SQRT2], [r + dr, c - dc, SQRT2]]) {
          if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
          best = Math.min(best, d[nr * W + nc] + w);
        }
        d[i] = best;
      }
    }
  };
  const forward = Array.from({ length: H }, (_, i) => i);
  const backward = forward.slice().reverse();
  const cols = Array.from({ length: W }, (_, i) => i);
  const colsBack = cols.slice().reverse();
  pass(forward, cols, -1, -1);
  pass(backward, colsBack, 1, 1);
  return d;
}
const toSea = distanceTo(0);
const toLand = distanceTo(1);
const signed = new Float32Array(W * H);
for (let i = 0; i < W * H; i += 1) signed[i] = land[i] ? toSea[i] : -toLand[i];

// ---- The depth bands: floor(signed / step). A cell is on a line where a neighbour is in a different band. ----
const band = (i) => Math.floor(signed[i] / STEP);
const bits = new Uint8Array(Math.ceil((W * H) / 8));
let lineCells = 0;
for (let r = 0; r < H; r += 1) {
  for (let c = 0; c < W; c += 1) {
    const i = r * W + c;
    const b = band(i);
    const neighbours = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
    // Longitude wraps: the cell on one edge sees the cell on the other edge as its neighbour.
    const wrapped = [[r, (c + W - 1) % W], [r, (c + 1) % W]];
    const edge = neighbours.some(([nr, nc]) => nr >= 0 && nr < H && nc >= 0 && nc < W && band(nr * W + nc) !== b)
      || wrapped.some(([nr, nc]) => band(nr * W + nc) !== b);
    if (edge) {
      bits[i >> 3] |= 0x80 >> (i & 7);
      lineCells += 1;
    }
  }
}

const base64 = Buffer.from(bits).toString("base64");
const source = [
  "// Generated by build-map.mjs from world-atlas@2.0.2 land-110m (Natural Earth, public domain). Do not edit by hand.",
  `export const WORLD_LINES = Object.freeze({ width: ${W}, height: ${H}, cellDegrees: ${CELL}, step: ${STEP}, lineCells: ${lineCells}, bits: "${base64}" });`,
  "",
].join("\n");
writeFileSync(output, source);
console.log(`wrote ${output}: ${W}x${H} cells, step ${STEP}, ${lineCells} line cells (${((100 * lineCells) / (W * H)).toFixed(1)}%), ${base64.length} base64 characters`);
