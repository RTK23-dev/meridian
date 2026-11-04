/**
 * How far the phone's map has moved up, as the page scrolls. The map travels a quarter of the scroll, so it reads as a place the page is
 * moving across, and it is capped so the map never leaves a visible gap at the bottom of the screen. Scrolling up, or no scroll, leaves it
 * where it is. Pure, so the behaviour can be tested without a browser.
 */
export const PHONE_MAP_TRAVEL = 0.25;
export const PHONE_MAP_MAX = 96;

export function phoneMapShift(scrollTop: number): number {
  if (!Number.isFinite(scrollTop) || scrollTop <= 0) return 0;
  return -Math.min(scrollTop * PHONE_MAP_TRAVEL, PHONE_MAP_MAX);
}
