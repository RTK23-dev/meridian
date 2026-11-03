// The site background as a square halftone, drawn at full resolution. The distance field is sampled smoothly at every block's centre, turned
// into tone bands, and printed as a grid of square blocks. Each block's side follows its tone, so darker bands take larger squares, and each
// block's opacity varies slightly, as in a printed halftone. It is the same drawing as docs/design/prototype/meridian-map/halftone.mjs.
import { CELL_DEG } from "./map-model.ts";

const MAP_W = 720;
const MAP_H = 360;
const LEVELS = 8;

/** The published look. Pitch is the grid's spacing in screen pixels; block is the largest square as a share of the pitch; sharp makes the tone
 *  bands crisper; step is the spacing of the bands in map cells; jitter is how far the opacity varies from block to block; zoom is pixels per
 *  degree. These are the owner's settings for the site. */
export const HALFTONE_DEFAULTS = Object.freeze({ pitch: 8, block: 1, sharp: 2, step: 11, jitter: 0.3, zoom: 8 });

export type HalftoneStyle = { pitch: number; block: number; sharp: number; step: number; jitter: number };
export type HalftoneView = { width: number; height: number; centreLat: number; zoom: number };
export type HalftonePalette = { bg: string; line: string };

const wrap = (value: number, period: number) => ((value % period) + period) % period;
const wrapLat = (lat: number) => wrap(lat + 90, 180) - 90;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
// A stable value from 0 to 1 for each block, so the variation does not change from frame to frame.
const hash01 = (i: number, j: number) => {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** The distance at a fractional map position. Columns wrap round the world, and rows are held at the poles. */
export function sampleField(field: Int8Array, col: number, row: number): number {
  const c = wrap(col, MAP_W);
  const r = clamp(row, 0, MAP_H - 1);
  const c0 = Math.floor(c);
  const c1 = (c0 + 1) % MAP_W;
  const fc = c - c0;
  const r0 = Math.floor(r);
  const r1 = Math.min(MAP_H - 1, r0 + 1);
  const fr = r - r0;
  const top = field[r0 * MAP_W + c0] * (1 - fc) + field[r0 * MAP_W + c1] * fc;
  const bottom = field[r1 * MAP_W + c0] * (1 - fc) + field[r1 * MAP_W + c1] * fc;
  return top * (1 - fr) + bottom * fr;
}

/** How much ink a block carries, from 0 to 1: the bands repeat every `step` cells, and `sharp` makes each band's crest narrower. */
export function inkAt(distance: number, step: number, sharp: number): number {
  const wave = 0.5 + 0.5 * Math.cos((2 * Math.PI * distance) / step);
  return wave ** sharp;
}

/** Draws the background into a context whose transform already maps one unit to one CSS pixel. The middle of the window is the meridian, at
 *  the latitude `centreLat`. Returns how many blocks were drawn, and the share of the window they cover. */
export function drawHalftone(
  ctx: CanvasRenderingContext2D,
  field: Int8Array,
  view: HalftoneView,
  style: HalftoneStyle,
  palette: HalftonePalette,
): { blocks: number; coverage: number } {
  const { width, height, centreLat, zoom } = view;
  const { pitch, block, sharp, step, jitter } = style;
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);
  const cols = Math.ceil(width / pitch);
  const rows = Math.ceil(height / pitch);
  const buckets: number[][] = Array.from({ length: LEVELS }, () => []);
  let blocks = 0;
  let area = 0;
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const x = (i + 0.5) * pitch;
      const y = (j + 0.5) * pitch;
      const lon = (x - width / 2) / zoom;
      const lat = wrapLat(centreLat - (y - height / 2) / zoom);
      const distance = sampleField(field, (lon + 180) / CELL_DEG - 0.5, (90 - lat) / CELL_DEG - 0.5);
      const ink = inkAt(distance, step, sharp);
      if (ink < 0.02) continue;
      const side = pitch * block * Math.sqrt(ink);
      const alpha = clamp(0.8 + 0.2 * ink + jitter * (2 * hash01(i, j) - 1), 0.2, 1);
      const level = clamp(Math.round(alpha * LEVELS) - 1, 0, LEVELS - 1);
      buckets[level].push(x - side / 2, y - side / 2, side);
      blocks += 1;
      area += side * side;
    }
  }
  ctx.fillStyle = palette.line;
  buckets.forEach((list, level) => {
    if (list.length === 0) return;
    ctx.globalAlpha = (level + 1) / LEVELS;
    ctx.beginPath();
    for (let n = 0; n < list.length; n += 3) ctx.rect(list[n], list[n + 1], list[n + 2], list[n + 2]);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  return { blocks, coverage: area / (width * height) };
}
