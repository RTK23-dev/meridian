// The rules of the site background, with no DOM. The map is the world's signed distance from the coast (world-field.ts). Each stop of the
// route is a latitude, and the map sits at the stop the page is on. The map glides to a new stop. It is the same model as
// docs/design/prototype/meridian-map/map-model.mjs, and a test in scripts/ checks the two agree.

/** One map cell is half a degree. */
export const CELL_DEG = 0.5;

/** How fast the map follows: each frame it closes this share of the gap to the stop's latitude. */
export const GLIDE = 0.69;

/** The stops of the route, as the latitude each one sits at: Switzerland, the Tropic of Cancer, the equator, the Tropic of Capricorn and
 *  Patagonia. The five places of the app each sit at one of them. */
export const STOP_LATITUDES = Object.freeze({
  cover: 47,
  create: 23,
  library: 0,
  insights: -23,
  settings: -41,
});
export type StopId = keyof typeof STOP_LATITUDES;

/** Decodes the base64 distance field: one signed byte per cell, so the bytes are read as Int8. */
export function decodeField(base64: string): Int8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}
