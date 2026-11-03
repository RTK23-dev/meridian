import { useRouterState } from "@tanstack/react-router";
import { SiteBackground } from "./site-background";
import { stopForPath } from "./stops";

/** The site background, placed by the route. It is mounted once, in the root, so every page sits on it. */
export function RouteBackground() {
  const pathname = useRouterState({ select: (state) => state.location.pathname.replace(/\/$/, "") || "/" });
  return <SiteBackground stop={stopForPath(pathname)} />;
}
