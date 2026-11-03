// The rules behind the site's background, with no DOM. The map is the world's signed distance from the coast (world-field.mjs), drawn as a
// halftone by halftone.mjs. The page moves along the meridian line: the scroll position sets a latitude, and the map is drawn at that latitude. Each screen
// is one stop on the route, and the route loops: after the last stop the map carries on over the pole and back to the first stop.

// One map cell is half a degree, and one screen cell is 4 px, so the map is drawn at 8 px per degree.
export const CELL_DEG = 0.5;
export const CELL_PX = 4;

// How fast the map follows the scroll: each frame it closes this share of the gap to the latitude of the screen, so 1 is at once and small
// values lag behind. Shared by the site and the simulator.
export const GLIDE = 0.69;

// The stops, in order, as the latitude each screen sits at. The loop stop is the first stop again, a half turn of the map further on.
export const ROUTE = Object.freeze([
  { id: "cover", lat: 47, place: "Switzerland" },
  { id: "create", lat: 23, place: "Tropic of Cancer" },
  { id: "library", lat: 0, place: "Equator" },
  { id: "insights", lat: -23, place: "Tropic of Capricorn" },
  { id: "settings", lat: -41, place: "Patagonia" },
]);
// The map repeats every 180 degrees of latitude, so a stop a half turn on is the same place, and the loop is seamless.
export const MAP_PERIOD = 180;
export const loopLatitudes = (route = ROUTE) => [...route.map((stop) => stop.lat), route[0].lat - MAP_PERIOD];

// The latitude at a scroll position. `p` counts screens: 0 is the top of the first screen, 1 is the top of the second. A screen at rest
// (its top on the top of the window) shows its stop's latitude, and between two screens the latitude moves in a straight line, so a
// swipe moves the map steadily. The loop screen is a half turn on, so its latitude is the first stop's, and the jump back to the first
// screen shows the same part of the map.
export function latitudeAt(p, lats) {
  if (p <= 0) return lats[0];
  const last = lats.length - 1;
  if (p >= last) return lats[last];
  const i = Math.floor(p);
  return lats[i] + (lats[i + 1] - lats[i]) * (p - i);
}

// The map cell a screen cell shows. The centre column is the meridian at longitude 0, and the centre row is the latitude `latC`. Columns
// wrap around the world, and rows wrap over the poles, so the loop never runs out of map.
export function sampleIndex(column, row, latC, cols, rows, width = 720, height = 360, degPerCell = CELL_DEG) {
  const lon = (column - Math.floor(cols / 2)) * degPerCell;
  const lat = latC + (Math.floor(rows / 2) - row) * degPerCell;
  const lonWrapped = ((((lon + 180) % 360) + 360) % 360);
  const latWrapped = ((((lat + 90) % 180) + 180) % 180) - 90;
  const mapColumn = Math.min(width - 1, Math.floor(lonWrapped / CELL_DEG));
  const mapRow = Math.min(height - 1, Math.floor((90 - latWrapped) / CELL_DEG));
  return mapRow * width + mapColumn;
}

// Decodes the packed line bits (one bit per map cell, most significant bit first) from base64.
export function decodeBits(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export function lineAt(bits, index) {
  return (bits[index >> 3] >> (7 - (index & 7))) & 1;
}

// The bills are printed by ordered dither: a pixel is yellow when its threshold, from a 4 by 4 Bayer matrix, is under the amount printed,
// times how strongly the pixel is part of the bill's art. The art is a border, an inner frame, a cross, and a light hatch.
export const BAYER4 = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16));
export function billWeight(x, y, width, height) {
  const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
  const inner = (x === 3 || y === 3 || x === width - 4 || y === height - 4) && x >= 3 && y >= 3 && x <= width - 4 && y <= height - 4;
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const cross = (Math.abs(x - cx) <= 3 && y === cy) || (Math.abs(y - cy) <= 3 && x === cx);
  if (edge || inner || cross) return 1;
  if ((x + y) % 4 === 0) return 0.55;
  return 0;
}
export function printed(threshold, amount, weight) {
  return weight > 0 && threshold < amount * weight;
}

// How far a bill is printed, from 0 to 1, by where its centre sits in the viewport: fully printed at the middle, and fading as it
// leaves the middle third of the screen. It changes with every scroll position, so moving up or down changes the reveal.
export function printFraction(centreY, viewportHeight) {
  return printFractionFor(centreY, viewportHeight, 0.6, "smoothstep");
}

// The same rule with its two settings open: how far from the middle the print starts to fade (a fraction of the viewport's height, where
// 0.6 is the published site), and the curve the fade follows.
export const PRINT_CURVES = Object.freeze(["linear", "smoothstep", "easeIn", "easeOut"]);
export function printFractionFor(centreY, viewportHeight, band = 0.6, curve = "smoothstep") {
  const offset = Math.abs(centreY - viewportHeight / 2) / (viewportHeight * band);
  const c = Math.min(1, Math.max(0, 1 - offset));
  if (curve === "linear") return c;
  if (curve === "easeIn") return c * c;
  if (curve === "easeOut") return 1 - (1 - c) * (1 - c);
  return c * c * (3 - 2 * c);
}

// The signed distance field (one signed byte per cell), from world-field.mjs.
export function decodeField(base64) {
  const bytes = decodeBits(base64);
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

// The depth lines for any spacing, by the same rule the published bits were built with: a cell is on a line where a neighbour is in a
// different band, looking up and down inside the map and across the longitude edges, which wrap.
export function linesFromField(field, width = 720, height = 360, step = 12) {
  const band = new Int32Array(width * height);
  for (let i = 0; i < width * height; i += 1) band[i] = Math.floor(field[i] / step);
  const lines = new Uint8Array(width * height);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const i = r * width + c;
      const b = band[i];
      const up = r > 0 && band[i - width] !== b;
      const down = r < height - 1 && band[i + width] !== b;
      const left = band[r * width + ((c + width - 1) % width)] !== b;
      const right = band[r * width + ((c + 1) % width)] !== b;
      lines[i] = up || down || left || right ? 1 : 0;
    }
  }
  return lines;
}
