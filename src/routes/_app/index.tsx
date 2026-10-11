import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button, PageHeader, Skeleton } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { useIntegrationsQuery, useMachinesQuery } from "@/lib/query/hooks";
import { hasRole } from "@/lib/meridian/access";
import { getOnboardingSteps, reviewedCreativeState } from "@/lib/onboarding";
import { providerLabel } from "@/lib/copy";
import { countDecidedReviews } from "@/components/brand-overview/pipeline";
import { KpiRow } from "@/components/home/kpi-row";
import { AttentionList } from "@/components/home/attention-list";
import { SetupChecklist } from "@/components/home/setup-checklist";
import { BrandGrid, type BrandLookup, type MachineState } from "@/components/home/brand-grid";
import { ActivityFeed } from "@/components/home/activity-feed";
import { CreateWorkspace } from "@/components/home/create-workspace";
import { attentionItems, homeKpis, isThinBrand, type ConnectionFact, type ReviewLoad } from "@/components/home/home-model";
import { useBrandReviewLists } from "@/components/home/use-brand-reviews";

export const Route = createFileRoute("/_app/")({ staticData: { pageTitle: "Overview" }, component: Home });

function Home() {
  const { data, loading, reload } = useWorkspace();
  const brandIds = data?.brands.map((brand) => brand.id) ?? [];
  const machines = useMachinesQuery(brandIds);
  const reviewLists = useBrandReviewLists(brandIds);
  const integrations = useIntegrationsQuery(data?.active?.id ?? "", !!data?.active);

  if (loading) return <div role="status" aria-label="Loading workspace" className="space-y-4"><Skeleton variant="card" /></div>;
  if (!data?.active) return <CreateWorkspace onCreated={reload} />;

  const machineByBrand = new Map<string, MachineState>(machines.map((query) => [query.brandId, machineStateOf(query)]));
  const lookup = (brandId: string): BrandLookup | undefined => machineByBrand.has(brandId)
    ? { machine: machineByBrand.get(brandId) ?? { status: "loading" } }
    : undefined;
  const brandNameById = new Map(data.brands.map((brand) => [brand.id, brand.name]));

  const reviews = reviewLoad(machines);
  const connectionsState = integrations.isPending ? "loading" : integrations.isError ? "error" : "ready";
  const connectionFacts: ConnectionFact[] = (integrations.data?.connections ?? []).map((connection) => ({
    provider: connection.provider,
    label: providerLabel(connection.provider),
    phase: connection.phase,
  }));
  const reviewsByBrand = data.brands.flatMap((brand) => {
    const state = machineByBrand.get(brand.id);
    return state?.status === "ready" ? [{ brandId: brand.id, brandName: brand.name, count: state.snapshot.counts.reviews }] : [];
  });
  const items = attentionItems({
    reviewsByBrand,
    failedJobs: data.overviewMetrics?.failedJobs ?? null,
    connections: connectionFacts,
    thinBrands: data.brands.filter(isThinBrand).map((brand) => ({ brandId: brand.id, brandName: brand.name, ratio: brand.completeness })),
  });
  const kpis = homeKpis({ brandCount: data.brands.length, reviews, overview: data.overviewMetrics });

  const hasConnectedProvider = connectionFacts.some((connection) => ["HEALTHY", "CONNECTED"].includes(connection.phase));
  // Each count is null until its data has loaded, so the checklist shows "Unknown" rather than "To do". The review check reads
  // the stored review lists, not the audit feed, which holds only the newest few entries.
  const setupSteps = getOnboardingSteps({
    brands: data.brands.map((brand) => {
      const snapshot = machineByBrand.get(brand.id);
      const counts = snapshot?.status === "ready" ? snapshot.snapshot.counts : null;
      return {
        id: brand.id,
        completeness: brand.completeness,
        competitors: counts ? counts.competitors : null,
        opportunities: counts ? counts.openOpportunities : null,
        creatives: counts ? counts.creatives : null,
      };
    }),
    providerConnected: connectionsState === "ready" ? hasConnectedProvider : null,
    reviewedCreative: reviewedCreativeState(reviewLists.map((query) => ({
      loaded: query.data !== undefined,
      decided: query.data ? countDecidedReviews(query.data.reviews) : 0,
      listed: query.data?.reviews.length ?? 0,
    }))),
  });
  const canCreate = hasRole(data.active.role, "member");

  return (
    <div className="space-y-10">
      <PageHeader
        title="Workspace overview"
        description={`A current view of ${data.active.name}, its brands, and work that needs attention.`}
        actions={canCreate ? <Button asChild><Link to="/brands/new"><Plus aria-hidden="true" className="mr-2 size-4" />New brand</Link></Button> : undefined}
      />
      <KpiRow kpis={kpis} />
      <AttentionList
        items={items}
        reviews={reviews}
        connections={connectionsState}
        onRetryReviews={() => { void Promise.all(machines.map((query) => query.refetch())); }}
        onRetryConnections={() => { void integrations.refetch(); }}
      />
      <SetupChecklist workspaceId={data.active.id} steps={setupSteps} />
      <BrandGrid brands={data.brands} lookup={lookup} canCreate={canCreate} />
      <ActivityFeed entries={data.audit} brandNameById={brandNameById} />
    </div>
  );
}

type MachineQuery = ReturnType<typeof useMachinesQuery>[number];

function machineStateOf(query: MachineQuery): MachineState {
  if (query.data) return { status: "ready", snapshot: query.data };
  if (query.isError) return { status: "error" };
  return { status: "loading" };
}

/** Open reviews across brands. Any failed or pending brand makes the total unknown, so the card is not shown as a finding. */
function reviewLoad(machines: MachineQuery[]): ReviewLoad {
  if (machines.some((query) => query.isError)) return { status: "error" };
  if (machines.some((query) => query.isPending)) return { status: "loading" };
  return { status: "ready", total: machines.reduce((count, query) => count + (query.data?.counts.reviews ?? 0), 0) };
}
