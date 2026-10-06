import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { formatDistanceToNow } from "date-fns";
import { Activity, AlertCircle, ArrowRight, BarChart3, CircleCheck, Clock3, Plus, Search, ServerCrash, Sparkles } from "lucide-react";
import { AuditList } from "@/components/audit";
import { useBusy } from "@/components/gate";
import { Button, EmptyState, ErrorState, Field, KpiCard, PageHeader, SelectInput, Skeleton, TextInput } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { useIntegrationsQuery, useMachinesQuery } from "@/lib/query/hooks";
import { hasRole } from "@/lib/meridian/access";
import { createOrganization } from "@/lib/meridian/api";
import { getOnboardingSteps } from "@/lib/onboarding";
import { workspaceNameSchema, type WorkspaceNameInput } from "@/lib/meridian/schemas/settings";

export const Route = createFileRoute("/")({ component: Home });

type SortMode = "activity" | "name" | "completeness";

function Home() {
  const { data, loading, reload } = useWorkspace();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("activity");
  const [dismissedChecklist, setDismissedChecklist] = useState<string | null>(null);
  const brandIds = data?.brands.map((brand) => brand.id) ?? [];
  const machines = useMachinesQuery(brandIds);
  const integrations = useIntegrationsQuery(data?.active?.id ?? "", !!data?.active);
  const machinesLoading = machines.some((query) => query.isPending);
  const machinesError = machines.find((query) => query.isError);
  const retryMachines = () => { void Promise.all(machines.map((query) => query.refetch())); };
  const machineByBrand = useMemo(() => new Map(machines.map((query) => [query.brandId, query.data])), [machines]);
  useEffect(() => {
    if (!data?.active?.id) return;
    try { setDismissedChecklist(localStorage.getItem(`meridian-onboarding-dismissed:${data.active.id}`) === "true" ? data.active.id : null); }
    catch { setDismissedChecklist(null); }
  }, [data?.active?.id]);

  if (loading) return <div role="status" aria-label="Loading workspace" className="space-y-4"><Skeleton variant="card" /></div>;
  if (!data?.active) return <CreateWorkspace onCreated={reload} />;

  const totalReviews = machines.reduce((count, query) => count + (query.data?.counts.reviews ?? 0), 0);
  const reviewBrand = machines.find((query) => (query.data?.counts.reviews ?? 0) > 0)?.brandId;
  const thinBrands = data.brands.filter((brand) => brand.completeness < 0.35);
  const disconnected = (integrations.data?.connections ?? []).filter((connection) => !["HEALTHY", "CONNECTED"].includes(connection.phase));
  const jobsFailed = data.overviewMetrics?.failedJobs;
  const livePublications = data.overviewMetrics?.livePublications;
  const lastPerformanceSync = data.overviewMetrics?.lastPerformanceSync;
  const attentionCount = (totalReviews ? 1 : 0) + (jobsFailed ? 1 : 0) + (disconnected.length ? 1 : 0) + (thinBrands.length ? 1 : 0);
  const visibleBrands = data.brands
    .filter((brand) => `${brand.name} ${brand.industry} ${brand.sells}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()))
    .sort((left, right) => sort === "name"
      ? left.name.localeCompare(right.name)
      : sort === "completeness"
        ? right.completeness - left.completeness
        : Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const canCreate = hasRole(data.active.role, "member");
  const hasConnectedProvider = (integrations.data?.connections ?? []).some((connection) => ["HEALTHY", "CONNECTED"].includes(connection.phase));
  const hasReviewedCreative = data.audit.some((entry) => entry.action === "review.approved" || entry.action === "review.rejected");
  const setupSteps = getOnboardingSteps({
    brands: data.brands.map((brand) => ({ id: brand.id, completeness: brand.completeness,
      competitors: machineByBrand.get(brand.id)?.counts.competitors ?? 0,
      opportunities: machineByBrand.get(brand.id)?.counts.openOpportunities ?? 0,
      creatives: machineByBrand.get(brand.id)?.counts.creatives ?? 0 })),
    providerConnected: hasConnectedProvider,
    reviewedCreative: hasReviewedCreative,
  });

  return <div className="space-y-8">
    <PageHeader
      title="Workspace overview"
      description={`A current view of ${data.active.name}, its brands, and work that needs attention.`}
      actions={canCreate ? <Button asChild><Link to="/brands/new"><Plus aria-hidden="true" className="mr-2 size-4" />New brand</Link></Button> : undefined}
    />

    <section aria-label="Workspace metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <KpiCard label="Brands" value={data.brands.length} icon={<Sparkles aria-hidden="true" className="size-5" />} description="In this workspace" />
      {!machinesLoading && !machinesError ? <KpiCard label="Open reviews" value={totalReviews} icon={<Clock3 aria-hidden="true" className="size-5" />} description="Across your brands" /> : <KpiSkeleton label="Open reviews" />}
      {jobsFailed != null ? <KpiCard label="Failed jobs" value={jobsFailed} icon={<ServerCrash aria-hidden="true" className="size-5" />} description="Dead-lettered in this workspace" /> : null}
      {livePublications != null ? <KpiCard label="Live publications" value={livePublications} icon={<BarChart3 aria-hidden="true" className="size-5" />} description="Confirmed provider ads" /> : null}
      {lastPerformanceSync ? <KpiCard label="Last performance sync" value={relativeTime(lastPerformanceSync)} icon={<Activity aria-hidden="true" className="size-5" />} description="Most recent provider observation" /> : null}
    </section>

    <section aria-labelledby="attention-title" className="space-y-3">
      <div className="flex items-end justify-between gap-3"><div><h2 id="attention-title" className="font-display text-2xl">Needs attention</h2><p className="mt-1 text-sm text-muted">Only recorded work and current connection states appear here.</p></div>{attentionCount ? <span className="rounded-full bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger">{attentionCount} item{attentionCount === 1 ? "" : "s"}</span> : null}</div>
      {machinesError ? <ErrorState message="Review counts could not be loaded." onRetry={retryMachines} /> : null}
      {integrations.isError ? <ErrorState message="Integration connection states could not be loaded." onRetry={() => void integrations.refetch()} /> : null}
      {!machinesLoading && !machinesError && !integrations.isPending && !integrations.isError && attentionCount === 0 ? <EmptyState icon={<CircleCheck aria-hidden="true" className="size-5" />} title="You’re up to date" reason="There are no open reviews, failed jobs, unconfigured provider states, or thin brand brains to resolve." /> : null}
      <ul className="grid gap-3 md:grid-cols-2">
        {reviewBrand && totalReviews ? <li><AttentionLink to={`/brands/${reviewBrand}/reviews`} icon={<Clock3 aria-hidden="true" className="size-5" />} title={`${totalReviews} review${totalReviews === 1 ? "" : "s"} waiting`} detail="Open the review queue and record a decision." /></li> : null}
        {jobsFailed ? <li><AttentionLink to="/integrations" icon={<ServerCrash aria-hidden="true" className="size-5" />} title={`${jobsFailed} job${jobsFailed === 1 ? "" : "s"} failed`} detail="Check worker health and configured services." /></li> : null}
        {disconnected.map((connection) => <li key={connection.provider}><AttentionLink to="/integrations" icon={<AlertCircle aria-hidden="true" className="size-5" />} title={`${providerName(connection.provider)} is ${connection.phase.toLocaleLowerCase().replaceAll("_", " ")}`} detail={connection.detail} /></li>)}
        {thinBrands.map((brand) => <li key={brand.id}><AttentionLink to={`/brands/${brand.id}/brain`} icon={<Sparkles aria-hidden="true" className="size-5" />} title={`${brand.name}’s brand brain is thin`} detail="Add confirmed audience, positioning, and voice evidence before making a recommendation." /></li>)}
      </ul>
    </section>

    {dismissedChecklist !== data.active.id ? <section aria-labelledby="setup-title" className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="setup-title" className="font-display text-2xl">Workspace setup</h2><p className="mt-1 text-sm text-muted">Progress reflects saved workspace and brand records.</p></div><Button type="button" variant="quiet" onClick={() => { try { localStorage.setItem(`meridian-onboarding-dismissed:${data.active!.id}`, "true"); } catch { /* Keep dismissal for this page view when storage is unavailable. */ } setDismissedChecklist(data.active!.id); }}>Dismiss checklist</Button></div>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{setupSteps.map((step) => <li key={step.label}><Link to={step.to as never} params={step.brandId ? { brandId: step.brandId } as never : undefined} className="flex min-h-12 items-center gap-3 rounded-md border border-line px-3 py-2 text-sm hover:border-brass"><CircleCheck aria-hidden="true" className={`size-4 shrink-0 ${step.done ? "text-success" : "text-muted"}`} /><span className={step.done ? "text-muted" : "font-medium"}>{step.label}</span>{step.done ? <span className="ml-auto text-xs text-success">Done</span> : <ArrowRight aria-hidden="true" className="ml-auto size-4 text-muted" />}</Link></li>)}</ol>
      {setupSteps.every((step) => step.done) ? <p className="mt-3 text-sm text-success">Each setup step has a matching stored record.</p> : null}
    </section> : null}

    <section aria-labelledby="brands-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 id="brands-title" className="font-display text-2xl">Brands</h2><p className="mt-1 text-sm text-muted">Open a brand to continue its research and creative work.</p></div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="relative block"><span className="sr-only">Search brands</span><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><TextInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search brands" className="pl-9" /></label>
          <label className="text-xs font-semibold text-muted">Sort by<SelectInput aria-label="Sort brands" className="mt-1 min-h-10 w-auto py-2" value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="activity">Recent activity</option><option value="name">Name</option><option value="completeness">Completeness</option></SelectInput></label>
        </div>
      </div>
      {data.brands.length === 0 ? <EmptyState title="No brands yet" reason="Add a brand you actually work on. Meridian will not fill this list with guessed information." action={canCreate ? <Button asChild><Link to="/brands/new">Create a brand</Link></Button> : undefined} /> : visibleBrands.length === 0 ? <EmptyState title="No matching brands" reason="Try another name, industry, or product description." /> : (
        <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {visibleBrands.map((brand) => {
            const snapshot = machineByBrand.get(brand.id);
            return <li key={brand.id}><Link to="/brands/$brandId" params={{ brandId: brand.id }} className="group block h-full rounded-xl border border-line bg-panel p-5 transition hover:border-brass hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass">
              <div className="flex items-start gap-3">
                <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-xl bg-paper font-display text-lg font-semibold text-brass">{brand.name.trim().slice(0, 1).toLocaleUpperCase() || "B"}</span>
                <div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><h3 className="truncate font-display text-xl group-hover:text-brass">{brand.name}</h3><Completeness value={brand.completeness} /></div><p className="mt-1 line-clamp-2 min-h-10 text-sm text-muted">{brand.sells || brand.industry || "No description yet."}</p></div>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span>{snapshot ? `${snapshot.counts.reviews} open review${snapshot.counts.reviews === 1 ? "" : "s"}` : "Loading review count…"}</span>
                <span>{brand.updatedAt ? `Updated ${relativeTime(brand.updatedAt)}` : "No recorded activity time"}</span>
              </div>
              {snapshot ? <div className="mt-4" aria-label="Brand pipeline counts"><MiniProgress label="Evidence" value={snapshot.counts.documents} secondaryLabel="Opportunities" secondaryValue={snapshot.counts.openOpportunities} /><MiniProgress label="Creatives" value={snapshot.counts.creatives} secondaryLabel="Performance rows" secondaryValue={snapshot.counts.performanceRows} /></div> : null}
              <span className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-brass">Open brand <ArrowRight aria-hidden="true" className="size-4" /></span>
            </Link></li>;
          })}
        </ul>
      )}
    </section>

    <section id="recent-activity" aria-labelledby="activity-title" className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3"><div><h2 id="activity-title" className="font-display text-xl">Recent activity</h2><p className="mt-1 text-sm text-muted">Recorded actions from this workspace audit trail.</p></div><Link to="/settings" hash="workspace-audit" className="text-sm font-semibold text-brass hover:underline">View all activity</Link></div>
      <AuditList entries={data.audit} />
    </section>
  </div>;
}

function KpiSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={`Loading ${label}`} className="rounded-lg border border-line bg-panel p-4"><Skeleton className="h-4 w-28" /><Skeleton className="mt-4 h-8 w-16" /><Skeleton className="mt-3 h-3 w-32" /></div>;
}

function AttentionLink({ to, icon, title, detail }: { to: string; icon: ReactNode; title: string; detail: string }) {
  if (to.startsWith("/brands/")) {
    const [brandId, ...parts] = to.slice("/brands/".length).split("/");
    const suffix = parts.join("/");
    const path = suffix ? `/brands/$brandId/${suffix}` : "/brands/$brandId";
    return <Link to={path as never} params={{ brandId } as never} className="flex h-full gap-3 rounded-lg border border-line bg-panel p-4 hover:border-brass"><span className="text-brass">{icon}</span><span className="min-w-0"><strong className="block text-sm">{title}</strong><span className="mt-1 block text-sm text-muted">{detail}</span></span></Link>;
  }
  return <Link to="/integrations" className="flex h-full gap-3 rounded-lg border border-line bg-panel p-4 hover:border-brass"><span className="text-accent">{icon}</span><span className="min-w-0"><strong className="block text-sm">{title}</strong><span className="mt-1 block text-sm text-muted">{detail}</span></span></Link>;
}

function Completeness({ value }: { value: number }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return <span className="grid size-11 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-ink" style={{ background: `conic-gradient(var(--color-accent) ${percent}%, var(--color-line) 0)` }} aria-label={`${percent}% complete`}><span className="grid size-8 place-items-center rounded-full bg-panel">{percent}%</span></span>;
}

function MiniProgress({ label, value, secondaryLabel, secondaryValue }: { label: string; value: number; secondaryLabel: string; secondaryValue: number }) {
  return <div className="flex items-center justify-between gap-2 border-t border-line py-2 text-xs"><span className="text-muted">{label} <strong className="text-ink">{value}</strong></span><span className="text-muted">{secondaryLabel} <strong className="text-ink">{secondaryValue}</strong></span></div>;
}

function providerName(value: string) {
  return ({ ad_library: "Ad Library", meta: "Meta", tiktok: "TikTok", google: "Google Ads" } as Record<string, string>)[value] ?? value;
}

function relativeTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unavailable" : formatDistanceToNow(date, { addSuffix: true });
}

function CreateWorkspace({ onCreated }: { onCreated: () => Promise<void> }) {
  const navigate = useNavigate();
  const { pending, error, run } = useBusy();
  const { register, handleSubmit, reset, formState: { errors, isDirty, isSubmitting } } = useForm<WorkspaceNameInput>({ resolver: zodResolver(workspaceNameSchema), defaultValues: { name: "" }, mode: "onBlur" });
  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [isDirty]);
  async function submit(values: WorkspaceNameInput) {
    const created = await run(async () => {
      await createOrganization({ data: values });
      await onCreated();
      await navigate({ to: "/" });
    });
    if (created) reset();
  }
  return <div className="mx-auto max-w-lg space-y-6">
    <div className="space-y-3"><p className="text-sm font-semibold uppercase tracking-widest text-brass">First step</p><h1 className="font-display text-4xl">Name the workspace</h1><p className="text-muted">A workspace holds brands. You will be the owner. Other people can be added later if they already have accounts.</p></div>
    <form onSubmit={handleSubmit(submit)} className="space-y-4" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }}><Field label="Workspace name" hint="Your company, studio, or agency." error={errors.name?.message} required><TextInput {...register("name")} required maxLength={80} /></Field>{isDirty ? <div role="status" className="flex items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm"><span>Unsaved changes</span><Button type="button" variant="quiet" onClick={() => reset()}>Clear form</Button></div> : null}{error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}<Button type="submit" disabled={pending || isSubmitting}>{pending || isSubmitting ? "Creating…" : "Create workspace"}</Button></form>
  </div>;
}
