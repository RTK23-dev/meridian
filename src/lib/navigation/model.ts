/**
 * Pure navigation rules for the signed-in shell. No React and no storage here, so each rule can be tested directly.
 */

export const APP_NAME = "Meridian";

export type NavItem = { id: string; label: string; to: string; badge?: number };
export type NavGroup = { id: string; label: string; items: NavItem[] };

/** The brand id in a brand-scoped path, or undefined on workspace pages. `/brands/new` is not a brand. */
export function brandIdFromPath(pathname: string): string | undefined {
  const id = pathname.match(/^\/brands\/([^/]+)/)?.[1];
  return id && id !== "new" ? id : undefined;
}

/**
 * Screens that were in the sidebar and now sit under Settings. The Settings screen lists them, so each one is still one
 * step from Settings, the command palette finds them, and no route changes. Labels are the accessible names, so they stay.
 */
export const SETTINGS_SCREEN_LINKS: NavItem[] = [
  { id: "billing", label: "Billing and limits", to: "/billing" },
  { id: "usage", label: "Usage & cost", to: "/usage" },
  { id: "alerts", label: "Alerts center", to: "/alerts" },
  { id: "audit", label: "Audit log", to: "/audit" },
  { id: "webhooks", label: "Webhook events", to: "/webhooks" },
  { id: "exports", label: "Exports", to: "/exports" },
  { id: "notifications", label: "Notification preferences", to: "/notifications" },
];

/**
 * Sidebar groups: Brand, Research, Content, Results, then Settings. Brand groups exist only on brand pages, so a workspace
 * page shows the workspace overview and Settings. The Content page holds ideas, creating, review, library, publishing,
 * results and the research-led Batch workflow, so the sidebar has one item for it. A badge appears only for a real count above zero: a null count (not
 * loaded yet, or failed) and a zero count both show no badge.
 */
/** The five places of the rail, in order. Each app screen is filed under one of them, as the screen table in the design plan (section 17)
 *  says. The places are the same on every page; the screens under them depend on whether a brand is open. */
export const PLACE_IDS = ["home", "create", "library", "insights", "settings"] as const;
export type PlaceId = (typeof PLACE_IDS)[number];

export function sidebarGroups({ brandId, reviewCount }: { brandId?: string; reviewCount: number | null }): NavGroup[] {
  // The Settings place opens the Settings page, so its first screen is that page.
  const settingsItems: NavItem[] = [
    { id: "settings", label: "Settings", to: "/settings" },
    { id: "setup", label: "Setup guide", to: "/setup" },
    { id: "integrations", label: "Integrations", to: "/integrations" },
    { id: "jobs", label: "Jobs & health", to: "/jobs" },
    { id: "engine-ops", label: "Engine operations", to: "/engine-ops" },
  ];
  if (!brandId) {
    return [
      { id: "home", label: "Home", items: [{ id: "overview", label: "Workspace overview", to: "/" }, { id: "alerts", label: "Alerts", to: "/alerts" }] },
      { id: "create", label: "Create", items: [{ id: "content-factory", label: "Content", to: "/content-factory" }, { id: "orchestrator", label: "Orchestrator", to: "/orchestrator" }] },
      { id: "library", label: "Library", items: [{ id: "exports", label: "Exports", to: "/exports" }] },
      // Insights is about a brand's market, so it has no screens until a brand is open.
      { id: "insights", label: "Insights", items: [] },
      { id: "settings", label: "Settings", items: settingsItems },
    ];
  }
  const base = `/brands/${brandId}`;
  // The badge counts the reviews waiting for a person. They are in this page's Review section.
  const openReviews = reviewCount !== null && reviewCount > 0 ? reviewCount : undefined;
  return [
    { id: "home", label: "Home", items: [{ id: "brand-overview", label: "Brand overview", to: base }, { id: "overview", label: "Workspace overview", to: "/" }, { id: "alerts", label: "Alerts", to: "/alerts" }] },
    {
      id: "create",
      label: "Create",
      items: [
        { id: "content", label: "Content", to: `${base}/content`, badge: openReviews },
        { id: "cookbooks", label: "Cookbooks", to: `${base}/cookbooks` },
        { id: "brain", label: "Brand brain", to: `${base}/brain` },
        { id: "products", label: "Products", to: `${base}/products` },
        { id: "pages", label: "Pages", to: `${base}/pages` },
        { id: "orchestrator", label: "Orchestrator", to: "/orchestrator" },
      ],
    },
    { id: "library", label: "Library", items: [{ id: "exports", label: "Exports", to: "/exports" }] },
    {
      id: "insights",
      label: "Insights",
      items: [
        { id: "market", label: "Market", to: `${base}/market` },
        { id: "intelligence", label: "Intelligence", to: `${base}/intelligence` },
        { id: "calibration", label: "Calibration", to: `${base}/calibration` },
      ],
    },
    { id: "settings", label: "Settings", items: settingsItems },
  ];
}

/** The place a path belongs to, or null for a page outside the five places (the sign-in, the product page, the docs). */
export function placeOf(pathname: string, brandId?: string): PlaceId | null {
  for (const group of sidebarGroups({ brandId, reviewCount: null })) {
    if (group.items.some((item) => isCurrentPath(pathname, item.to))) return group.id as PlaceId;
  }
  if (SETTINGS_SCREEN_LINKS.some((item) => isCurrentPath(pathname, item.to))) return "settings";
  return null;
}

/**
 * Where each kind of work lives on a brand, in words a new person can use. The brand overview shows this list. Each path is a screen
 * the sidebar lists, and a test keeps it that way. Ideas, creating, review, library, publishing, results and Batch are sections of the
 * Content page.
 */
export const AREA_GUIDE: ReadonlyArray<{ id: string; label: string; path: string; what: string }> = [
  { id: "cookbooks", label: "Cookbooks", path: "cookbooks", what: "The cookbooks a video can be made from: their steps, their cost and what each needs, and copies you can make and edit." },
  { id: "market", label: "Market", path: "market", what: "Find public pages and posts, collect ads, and store competitor observations." },
  { id: "content", label: "Content", path: "content", what: "Ideas ranks what to make next. Create makes images and videos, Review holds them for a person, Library keeps them, Publish sends them out, Results shows what worked, and Batch (admins only) starts research-led production runs." },
];

/**
 * The screen a person goes to next, keyed by the current sidebar item id. The loop runs Intelligence, Content, Calibration,
 * then back to Content. The brand overview is not listed: its own next-action card names the next step from stored data,
 * so a second link would contradict it.
 */
const BRAND_NEXT: Record<string, string> = {
  brain: "products",
  products: "market",
  market: "intelligence",
  intelligence: "content",
  content: "calibration",
  cookbooks: "content",
  calibration: "content",
};

const WORKSPACE_NEXT: Record<string, string> = { setup: "overview" };

/** The next screen after the current one, or null when the current page is not in the sidebar or has no next step. */
export function nextStep({ pathname, brandId }: { pathname: string; brandId?: string }): NavItem | null {
  const items = sidebarGroups({ brandId, reviewCount: null }).flatMap((group) => group.items);
  const current = items.find((item) => isCurrentPath(pathname, item.to));
  if (!current) return null;
  const nextId = brandId ? BRAND_NEXT[current.id] : WORKSPACE_NEXT[current.id];
  return (nextId ? items.find((item) => item.id === nextId) : undefined) ?? null;
}

/** Every screen the command palette can open: the sidebar screens for this page, then the screens listed under Settings. A screen that is
 *  listed twice is offered once. */
export function paletteScreens(brandId?: string): NavItem[] {
  const seen = new Set<string>();
  return [...sidebarGroups({ brandId, reviewCount: null }).flatMap((group) => group.items), ...SETTINGS_SCREEN_LINKS].filter((item) => {
    if (seen.has(item.to)) return false;
    seen.add(item.to);
    return true;
  });
}

/** The five places as the bottom bar on a phone, in the rail's order. Each opens the place's first screen. A place with no screen on this page
 *  has an empty target, and the bar shows it as unavailable rather than linking it to some other page. */
export function bottomTabs(brandId?: string): Array<NavItem & { place: PlaceId }> {
  return sidebarGroups({ brandId, reviewCount: null }).map((group) => ({
    id: group.id,
    place: group.id as PlaceId,
    label: group.label,
    to: group.items[0]?.to ?? "",
  }));
}

/**
 * How the workspace and brand switchers show. The expanded sidebar and the mobile sheet show two selects. The collapsed rail is
 * too narrow for a select, so it shows one button instead, which opens the command palette. The palette switches both.
 */
export function switcherMode({ collapsed, mobile }: { collapsed: boolean; mobile: boolean }): "selects" | "rail-button" {
  return collapsed && !mobile ? "rail-button" : "selects";
}

/** Trailing slashes do not change the page. `/brands/x/` and `/brands/x` are the same screen. */
export function isCurrentPath(pathname: string, to: string): boolean {
  const normalize = (value: string) => value.length > 1 ? value.replace(/\/+$/, "") : value;
  return normalize(pathname) === normalize(to);
}

/** Document title: page first, then brand, then the app name. Empty parts are dropped. */
export function documentTitle({ page, brandName }: { page?: string; brandName?: string }): string {
  return [page, brandName, APP_NAME]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(" · ");
}

/** A permission or origin refusal. Route errors with this shape show the forbidden page instead of a retry. */
export function isForbiddenError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 403) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /do not have permission|forbidden/i.test(message);
}

/** getAlerts returns at most this many rows, so a full list means the real unread count may be higher. */
export const ALERT_LIST_LIMIT = 40;

/** The bell label: null when nothing is unread, otherwise the unread count (with "+" when the list is capped). */
export function unreadAlertLabel(alerts: readonly { acknowledged: boolean }[]): string | null {
  const unread = alerts.filter((alert) => !alert.acknowledged).length;
  if (unread === 0) return null;
  return alerts.length >= ALERT_LIST_LIMIT ? `${unread}+` : String(unread);
}

export const LAST_BRAND_KEY = "meridian-last-brand";

/** The remembered brand, but only while it still belongs to the active workspace. A stale id resolves to null. */
export function resolveLastBrand(stored: string | null, brandIds: readonly string[]): string | null {
  if (!stored) return null;
  return brandIds.includes(stored) ? stored : null;
}
