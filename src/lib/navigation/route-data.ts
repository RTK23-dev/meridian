import type {} from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Screen name for the breadcrumb, the document title and the route announcement. Set in each route file. */
    pageTitle?: string;
  }
}

type MatchLike = { staticData?: { pageTitle?: string } };

/** The deepest matched route that declares a page title. */
export function routePageTitle(matches: readonly MatchLike[]): string | undefined {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const title = matches[index]?.staticData?.pageTitle;
    if (title) return title;
  }
  return undefined;
}
