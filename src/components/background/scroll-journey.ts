/**
 * How far along the map the page has travelled as it scrolls. The map moves with the page one to one, as if it were printed as long as the
 * page: every pixel scrolled moves the map by the same pixel, so scrolling from the top of a page to its bottom is one continuous journey
 * south along the meridian, and the map never stops while the page still moves. Pure, so it can be tested without a browser.
 */
export function scrollTravel(scrollTop: number, zoom: number): number {
  if (!Number.isFinite(scrollTop) || scrollTop <= 0 || !Number.isFinite(zoom) || zoom <= 0) return 0;
  return scrollTop / zoom;
}

/** The journey's position for a page at a stop, scrolled by `scrollTop` pixels: the stop's latitude, then south as the page goes down. */
export function journeyPosition(stopLatitude: number, scrollTop: number, zoom: number): number {
  return stopLatitude - scrollTravel(scrollTop, zoom);
}
