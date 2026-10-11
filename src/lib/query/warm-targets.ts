/**
 * Which queries a link's target screen reads, so hovering or focusing the link can warm them. Pure: it decides from the
 * path alone. prefetch.ts maps each entry to the option factory the screen's hook uses.
 *
 * A link may carry a query string, a hash or a trailing slash. None of them changes the screen, so they are stripped first.
 * `/brands/new` is the create page, not a brand, so it warms nothing.
 */

export type WarmQuery =
  | "brand" | "machine" | "market" | "intelligence" | "opportunities" | "reviews" | "studio" | "library"
  | "learning" | "telemetry" | "calibration" | "assets" | "accounts" | "factory"
  | "integrations" | "jobs" | "usage" | "alerts" | "notifications" | "providerSettings";

/** Brand-scoped entries use the brand id. Workspace entries use the active organization id. */
export type WarmSpec = { query: WarmQuery; scope: "brand" | "organization"; id: string };

/** The queries each brand screen reads, keyed by the path segment after the brand id ("" is the brand overview). */
const BRAND_SCREENS: ReadonlyMap<string, readonly WarmQuery[]> = new Map([
  ["", ["brand", "machine"]],
  ["market", ["market"]],
  ["intelligence", ["intelligence"]],
  ["opportunities", ["opportunities"]],
  ["reviews", ["reviews"]],
  ["studio", ["studio"]],
  ["library", ["library"]],
  ["learning", ["learning", "telemetry"]],
  ["calibration", ["calibration"]],
  ["brain", ["brand", "assets"]],
  ["products", ["brand"]],
  ["accounts", ["accounts"]],
  ["factory", ["factory"]],
]);

/** The queries each workspace screen reads. Screens with filter or page state (audit, webhooks) are not warmed. */
const ORGANIZATION_SCREENS: ReadonlyMap<string, readonly WarmQuery[]> = new Map([
  ["/integrations", ["integrations"]],
  ["/jobs", ["jobs"]],
  ["/usage", ["usage"]],
  ["/alerts", ["alerts"]],
  ["/notifications", ["notifications"]],
  ["/settings", ["providerSettings"]],
]);

/** The path without its query string, hash or trailing slashes. The root stays "/". */
export function normalizeWarmPath(to: string): string {
  const path = to.split(/[?#]/)[0] ?? "";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function warmSpecs(to: string, scope: { signedIn: boolean; organizationId: string | null | undefined }): WarmSpec[] {
  if (!scope.signedIn) return [];
  const path = normalizeWarmPath(to);
  const brand = path.match(/^\/brands\/([^/]+)(?:\/([^/]+))?$/);
  if (brand) {
    const brandId = brand[1] ?? "";
    if (brandId === "new") return [];
    const queries = BRAND_SCREENS.get(brand[2] ?? "") ?? [];
    return queries.map((query) => ({ query, scope: "brand", id: brandId }));
  }
  if (!scope.organizationId) return [];
  const queries = ORGANIZATION_SCREENS.get(path) ?? [];
  return queries.map((query) => ({ query, scope: "organization", id: scope.organizationId as string }));
}
