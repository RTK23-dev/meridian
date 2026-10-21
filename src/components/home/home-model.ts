/**
 * Pure model for the workspace home. A card or item appears only when a stored source supplies it. A missing source hides
 * the card, and a failed source is shown as an error elsewhere on the page. Nothing here invents a value or a finding.
 */
import { formatDistanceToNow } from "date-fns";
import type { BrandSummary } from "@/lib/meridian/workspace/actions";
import type { PlanStatus } from "../../engine/orchestrator/store.ts";
import { stepPath } from "../../lib/progress/step-url.ts";

export type OverviewMetrics = {
  failedJobs: number;
  livePublications: number;
  lastPerformanceSync: string | null;
};

export type ReviewLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; total: number };

export type KpiId = "brands" | "openReviews" | "failedJobs" | "livePublications" | "lastSync";

/** value is null while the source loads. Cards with no source are not returned at all. */
export type KpiSpec = { id: KpiId; label: string; description: string; value: number | string | null };

export function homeKpis(input: { brandCount: number; reviews: ReviewLoad; overview: OverviewMetrics | null }): KpiSpec[] {
  const kpis: KpiSpec[] = [{ id: "brands", label: "Brands", description: "In this workspace", value: input.brandCount }];
  if (input.reviews.status === "loading") kpis.push({ id: "openReviews", label: "Open reviews", description: "Across your brands", value: null });
  if (input.reviews.status === "ready") kpis.push({ id: "openReviews", label: "Open reviews", description: "Across your brands", value: input.reviews.total });
  if (input.overview) {
    kpis.push({ id: "failedJobs", label: "Failed jobs", description: "Dead-lettered in this workspace", value: input.overview.failedJobs });
    kpis.push({ id: "livePublications", label: "Live publications", description: "Confirmed provider ads", value: input.overview.livePublications });
    kpis.push({
      id: "lastSync",
      label: "Last performance sync",
      description: input.overview.lastPerformanceSync ? "Most recent provider observation" : "No provider performance row is stored",
      value: input.overview.lastPerformanceSync ? relativeTime(input.overview.lastPerformanceSync) : "None recorded",
    });
  }
  return kpis;
}

export type AttentionTone = "accent" | "danger" | "neutral";
export type AttentionTarget = "/jobs" | "/integrations" | "/brands/$brandId/reviews" | "/brands/$brandId/brain";
export type AttentionItem = { id: string; tone: AttentionTone; title: string; detail: string; to: AttentionTarget; brandId?: string };

export type ConnectionFact = { provider: string; label: string; phase: string };

export function attentionItems(input: {
  reviewsByBrand: Array<{ brandId: string; brandName: string; count: number }>;
  failedJobs: number | null;
  connections: ConnectionFact[];
  thinBrands: Array<{ brandId: string; brandName: string; ratio: number }>;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const review of input.reviewsByBrand) {
    if (review.count <= 0) continue;
    items.push({
      id: `reviews:${review.brandId}`,
      tone: "accent",
      title: `${review.count} review${review.count === 1 ? "" : "s"} waiting in ${review.brandName}`,
      detail: "Approve or reject each held creative.",
      to: "/brands/$brandId/reviews",
      brandId: review.brandId,
    });
  }
  if (input.failedJobs && input.failedJobs > 0) {
    items.push({
      id: "jobs:dead",
      tone: "danger",
      title: `${input.failedJobs} job${input.failedJobs === 1 ? "" : "s"} failed`,
      detail: "Open Jobs to read the recorded error.",
      to: "/jobs",
    });
  }
  const notConnected: string[] = [];
  for (const connection of input.connections) {
    if (connection.phase === "FAILED") {
      items.push({ id: `provider:${connection.provider}`, tone: "danger", title: `${connection.label} request failed`, detail: "Test the connection on Integrations.", to: "/integrations" });
    } else if (connection.phase === "DISCONNECTED") {
      items.push({ id: `provider:${connection.provider}`, tone: "neutral", title: `${connection.label} is disconnected`, detail: "No requests are sent until someone reconnects.", to: "/integrations" });
    } else if (connection.phase === "DEGRADED") {
      items.push({ id: `provider:${connection.provider}`, tone: "neutral", title: `${connection.label} is degraded`, detail: "The last successful request is stale.", to: "/integrations" });
    } else if (connection.phase === "NOT_CONFIGURED") {
      notConnected.push(connection.label);
    }
  }
  if (notConnected.length > 0) {
    items.push({
      id: "providers:not-connected",
      tone: "neutral",
      title: `Not connected: ${notConnected.join(", ")}`,
      detail: "No request was sent. Connect them on Integrations.",
      to: "/integrations",
    });
  }
  for (const brand of input.thinBrands) {
    items.push({
      id: `brain:${brand.brandId}`,
      tone: "neutral",
      title: `${brand.brandName}’s brand brain is thin`,
      detail: `${Math.round(brand.ratio * 100)}% of required brain fields are filled`,
      to: "/brands/$brandId/brain",
      brandId: brand.brandId,
    });
  }
  return items;
}

export type NeedsYouItem = { id: string; title: string; reason: string; action: { label: string; to: string } };

/** A stored plan as Home reads it: its id, its title and its status. */
export type NeedsYouPlan = { id: string; title: string; status: PlanStatus };

/** A brand account and its stored connection state. Only "not_connected" is listed. "unknown" is never shown as a finding. */
export type NeedsYouAccount = { id: string; brandId: string; name: string; state: "connected" | "not_connected" | "unknown" };

/**
 * The Needs you list for Home, built only from stored data. A plan is listed when it is refused, paused at budget or
 * incomplete. An account is listed when its stored state is not connected, and the item says what connecting it does.
 */
export function needsYouItems(input: { plans: NeedsYouPlan[]; accounts: NeedsYouAccount[] }): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const plan of input.plans) {
    const name = plan.title.trim() || "Untitled plan";
    const action = { label: "Open plan", to: stepPath(`/create/${encodeURIComponent(plan.id)}`, "plan") };
    if (plan.status === "refused") {
      items.push({ id: `plan:${plan.id}`, title: `${name} was refused`, reason: "The plan was refused. Read the reason, then edit the brief.", action });
    } else if (plan.status === "paused") {
      items.push({ id: `plan:${plan.id}`, title: `${name} paused at budget`, reason: "The run paused at its budget. Raise the budget to continue.", action });
    } else if (plan.status === "incomplete") {
      items.push({ id: `plan:${plan.id}`, title: `${name} is incomplete`, reason: "Some steps did not finish. Run the plan again to finish them.", action });
    }
  }
  for (const account of input.accounts) {
    if (account.state !== "not_connected") continue;
    items.push({
      id: `account:${account.id}`,
      title: `${account.name} is not connected`,
      reason: "Connect it to publish from this brand.",
      action: { label: "Connect account", to: `/brands/${encodeURIComponent(account.brandId)}/accounts` },
    });
  }
  return items;
}

export type BrandSort = "activity" | "name" | "completeness";

/** Filters by name, industry and what the brand sells, then sorts. Ties on activity and completeness fall back to name. */
export function visibleBrands<T extends Pick<BrandSummary, "name" | "industry" | "sells" | "completeness" | "updatedAt">>(
  brands: T[],
  search: string,
  sort: BrandSort,
): T[] {
  const needle = search.toLocaleLowerCase().trim();
  const matching = brands.filter((brand) => `${brand.name} ${brand.industry} ${brand.sells}`.toLocaleLowerCase().includes(needle));
  return [...matching].sort((left, right) => {
    if (sort === "name") return left.name.localeCompare(right.name);
    if (sort === "completeness") return right.completeness - left.completeness || left.name.localeCompare(right.name);
    return activityTime(right.updatedAt) - activityTime(left.updatedAt) || left.name.localeCompare(right.name);
  });
}

export function activityTime(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/** A brand is thin until every required brain field has content. The gate is the stored requiredComplete flag, not the ratio. */
export function isThinBrand(brand: Pick<BrandSummary, "requiredComplete">): boolean {
  return !brand.requiredComplete;
}

/** A readable relative time, or a plain fallback when the stored value is not a date. */
export function relativeTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unavailable" : formatDistanceToNow(date, { addSuffix: true });
}
