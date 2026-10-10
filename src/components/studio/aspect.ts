/**
 * Frame shape for a variant card. The shape comes from the stored width and height, so a 9:16 clip gets a tall frame and a
 * 16:9 clip a wide one. Missing dimensions fall back to 16:9 for the frame only, and the card says they are not stored.
 */

export type Orientation = "portrait" | "landscape" | "square" | "unknown";

export type FrameShape = {
  /** CSS aspect-ratio value, such as "1080 / 1920". */
  css: string;
  /** The reduced ratio when it is simple, such as "9:16". Otherwise the pixel size. */
  label: string;
  orientation: Orientation;
  /** False when the stored dimensions are missing, so the frame is a placeholder. */
  stored: boolean;
};

const FALLBACK_CSS = "16 / 9";

function isPositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

export function frameShape(width: number | null | undefined, height: number | null | undefined): FrameShape {
  if (!isPositive(width) || !isPositive(height)) {
    return { css: FALLBACK_CSS, label: "Dimensions not stored", orientation: "unknown", stored: false };
  }
  const w = Math.round(width);
  const h = Math.round(height);
  const divisor = greatestCommonDivisor(w, h) || 1;
  const reducedW = w / divisor;
  const reducedH = h / divisor;
  const label = reducedW <= 32 && reducedH <= 32 ? `${reducedW}:${reducedH}` : `${w} × ${h} px`;
  const orientation: Orientation = w === h ? "square" : w < h ? "portrait" : "landscape";
  return { css: `${w} / ${h}`, label, orientation, stored: true };
}

/** Caps the width of a frame so a tall clip does not fill the whole card. */
export function frameWidthClass(orientation: Orientation): string {
  if (orientation === "portrait") return "mx-auto w-full max-w-[18rem]";
  if (orientation === "square") return "mx-auto w-full max-w-md";
  return "w-full";
}
