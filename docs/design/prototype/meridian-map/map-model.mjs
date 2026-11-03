// The rules behind the site's background, with no DOM. The map is the world's depth map (world-lines.mjs), drawn one 4 px cell at a time.
// The page moves along the meridian line: the scroll position sets a latitude, and the map shows the cells at that latitude. Each screen
// is one stop on the route, and the route loops: after the last stop the map carries on over the pole and back to the first stop.

// One map cell is half a degree, and one screen cell is 4 px, so the map is drawn at 8 px per degree.
export const CELL_DEG = 0.5;
export const CELL_PX = 4;

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
export function sampleIndex(column, row, latC, cols, rows, width = 720, height = 360) {
  const lon = (column - Math.floor(cols / 2)) * CELL_DEG;
  const lat = latC + (Math.floor(rows / 2) - row) * CELL_DEG;
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
  const offset = Math.abs(centreY - viewportHeight / 2) / (viewportHeight * 0.6);
  const clamped = Math.min(1, Math.max(0, 1 - offset));
  return clamped * clamped * (3 - 2 * clamped);
}
