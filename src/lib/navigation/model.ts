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
  { id: "usage", label: "Usage & cost", to: "/usage" },
  { id: "alerts", label: "Alerts center", to: "/alerts" },
  { id: "audit", label: "Audit log", to: "/audit" },
  { id: "webhooks", label: "Webhook events", to: "/webhooks" },
  { id: "exports", label: "Exports", to: "/exports" },
  { id: "notifications", label: "Notification preferences", to: "/notifications" },
];

/**
 * Sidebar groups: Brand, Research, Create, Review, Results, then Settings. Brand groups exist only on brand pages, so a
 * workspace page shows the workspace overview and Settings. A badge appears only for a real count above zero: a null
 * count (not loaded yet, or failed) and a zero count both show no badge.
 */
export function sidebarGroups({ brandId, reviewCount }: { brandId?: string; reviewCount: number | null }): NavGroup[] {
  const settings: NavGroup = {
    id: "settings",
    label: "Settings",
    items: [
      { id: "setup", label: "Setup guide", to: "/setup" },
      { id: "integrations", label: "Integrations", to: "/integrations" },
      { id: "jobs", label: "Jobs & health", to: "/jobs" },
      { id: "settings", label: "Settings", to: "/settings" },
    ],
  };
  if (!brandId) {
    return [{ id: "overview", label: "Overview", items: [{ id: "overview", label: "Workspace overview", to: "/" }] }, settings];
  }
  const base = `/brands/${brandId}`;
  const openReviews = reviewCount !== null && reviewCount > 0 ? reviewCount : undefined;
  return [
    {
      id: "brand",
      label: "Brand",
      items: [
        { id: "brand-overview", label: "Overview", to: base },
        { id: "brain", label: "Brand brain", to: `${base}/brain` },
        { id: "products", label: "Products", to: `${base}/products` },
        // Brand-scoped, so it sits here rather than in the workspace-level account menu.
        { id: "accounts", label: "Connected accounts", to: `${base}/accounts` },
      ],
    },
    {
      id: "research",
      label: "Research",
      items: [
        { id: "market", label: "Market", to: `${base}/market` },
        { id: "intelligence", label: "Intelligence", to: `${base}/intelligence` },
      ],
    },
    {
      id: "create",
      label: "Create",
      items: [
        { id: "studio", label: "Studio", to: `${base}/studio` },
        { id: "factory", label: "Factory", to: `${base}/factory` },
        { id: "library", label: "Library", to: `${base}/library` },
      ],
    },
    {
      id: "review",
      label: "Review",
      items: [
        { id: "opportunities", label: "Opportunities", to: `${base}/opportunities` },
        { id: "reviews", label: "Reviews", to: `${base}/reviews`, badge: openReviews },
      ],
    },
    {
      id: "results",
      label: "Results",
      items: [
        { id: "learning", label: "Learning", to: `${base}/learning` },
        { id: "calibration", label: "Calibration", to: `${base}/calibration` },
      ],
    },
    settings,
  ];
}

/**
 * The screen a person goes to next, keyed by the current sidebar item id. The loop runs Opportunities, Studio, Reviews,
 * Library, Learning, Calibration, then back to Opportunities. The brand overview is not listed: its own next-action card
 * names the next step from stored data, so a second link would contradict it.
 */
const BRAND_NEXT: Record<string, string> = {
  brain: "products",
  products: "accounts",
  accounts: "market",
  market: "intelligence",
  intelligence: "opportunities",
  opportunities: "studio",
  studio: "reviews",
  factory: "reviews",
  reviews: "library",
  library: "learning",
  learning: "calibration",
  calibration: "opportunities",
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

/** Every screen the command palette can open: the sidebar screens for this page, then the screens listed under Settings. */
export function paletteScreens(brandId?: string): NavItem[] {
  return [...sidebarGroups({ brandId, reviewCount: null }).flatMap((group) => group.items), ...SETTINGS_SCREEN_LINKS];
}

/** The four bottom-bar tabs. The More tab is added by the shell and opens the full navigation sheet. */
export function bottomTabs(brandId?: string): NavItem[] {
  if (!brandId) {
    return [
      { id: "overview", label: "Overview", to: "/" },
      { id: "setup", label: "Setup", to: "/setup" },
      { id: "alerts", label: "Alerts", to: "/alerts" },
      { id: "settings", label: "Settings", to: "/settings" },
    ];
  }
  const base = `/brands/${brandId}`;
  return [
    { id: "overview", label: "Overview", to: base },
    { id: "opportunities", label: "Opportunities", to: `${base}/opportunities` },
    { id: "studio", label: "Studio", to: `${base}/studio` },
    { id: "reviews", label: "Reviews", to: `${base}/reviews` },
  ];
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
