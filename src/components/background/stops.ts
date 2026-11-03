// The stop each page sits at, with no React: the five places map to the five stops of the route, in order.
import { brandIdFromPath, placeOf, type PlaceId } from "../../lib/navigation/model.ts";
import type { StopId } from "./map-model.ts";

/** The stop of the route each place sits at. */
export const STOP_FOR_PLACE: Record<PlaceId, StopId> = { home: "cover", create: "create", library: "library", insights: "insights", settings: "settings" };

/** The stop a page sits at: its place's stop, or the first stop for a page outside the places (the sign-in, the product page and the docs). */
export function stopForPath(pathname: string): StopId {
  const place = placeOf(pathname, brandIdFromPath(pathname));
  return place ? STOP_FOR_PLACE[place] : "cover";
}
