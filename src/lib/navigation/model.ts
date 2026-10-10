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
 * Sidebar groups in workflow order. Brand groups exist only on brand pages. A badge appears only for a real count
 * above zero: a null count (not loaded yet, or failed) and a zero count both show no badge.
 */
export function sidebarGroups({ brandId, reviewCount }: { brandId?: string; reviewCount: number | null }): NavGroup[] {
  const workspace: NavGroup = {
    id: "workspace",
    label: "Workspace",
    items: [
      { id: "jobs", label: "Jobs & health", to: "/jobs" },
      { id: "usage", label: "Usage & cost", to: "/usage" },
      { id: "alerts", label: "Alerts center", to: "/alerts" },
      { id: "integrations", label: "Integrations", to: "/integrations" },
      { id: "settings", label: "Settings", to: "/settings" },
      { id: "audit", label: "Audit log", to: "/audit" },
      { id: "webhooks", label: "Webhook events", to: "/webhooks" },
    ],
  };
  if (!brandId) {
    return [{ id: "overview", label: "Overview", items: [{ id: "overview", label: "Overview", to: "/" }] }, workspace];
  }
  const base = `/brands/${brandId}`;
  const openReviews = reviewCount !== null && reviewCount > 0 ? reviewCount : undefined;
  return [
    { id: "overview", label: "Overview", items: [{ id: "brand-overview", label: "Overview", to: base }] },
    {
      id: "research",
      label: "Research",
      items: [
        { id: "market", label: "Market", to: `${base}/market` },
        { id: "intelligence", label: "Intelligence", to: `${base}/intelligence` },
      ],
    },
    {
      id: "decide",
      label: "Decide",
      items: [
        { id: "opportunities", label: "Opportunities", to: `${base}/opportunities` },
        { id: "reviews", label: "Reviews", to: `${base}/reviews`, badge: openReviews },
      ],
    },
    {
      id: "create",
      label: "Create",
      items: [
        { id: "studio", label: "Studio", to: `${base}/studio` },
        { id: "library", label: "Library", to: `${base}/library` },
      ],
    },
    { id: "learn", label: "Learn", items: [{ id: "learning", label: "Learning", to: `${base}/learning` }] },
    {
      id: "brand",
      label: "Brand",
      items: [
        { id: "brain", label: "Brand brain", to: `${base}/brain` },
        { id: "products", label: "Products", to: `${base}/products` },
      ],
    },
    workspace,
  ];
}

/** The four bottom-bar tabs. The More tab is added by the shell and opens the full navigation sheet. */
export function bottomTabs(brandId?: string): NavItem[] {
  if (!brandId) {
    return [
      { id: "overview", label: "Overview", to: "/" },
      { id: "alerts", label: "Alerts", to: "/alerts" },
      { id: "integrations", label: "Integrations", to: "/integrations" },
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

/** Trailing slashes do not change the page. `/brands/x/` and `/brands/x` are the same screen. */
export function isCurrentPath(pathname: string, to: string): boolean {
  const normalize = (value: string) => value.length > 1 ? value.replace(/\/+$/, "") : value;
  return normalize(pathname) === normalize(to);
}

/** Document title: page first, then brand, then the app name. Empty parts are dropped. */
export function documentTitle({ page, brandName }: { page?: string; brandName?: string }): string {
  return [page, brandName, APP_NAME]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
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
