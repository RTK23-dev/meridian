import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button, PageHeader, Skeleton } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { useDecisionEnginesQuery, useIntegrationsQuery, useMachinesQuery, useProviderSettingsQuery } from "@/lib/query/hooks";
import { hasRole } from "@/lib/meridian/access";
import { providerLabel } from "@/lib/copy";
import { KpiRow } from "@/components/home/kpi-row";
import { TeamPanel } from "@/components/home/team-panel";
import { teamStates } from "@/components/home/team-model";
import { AttentionList } from "@/components/home/attention-list";
import { SetupCallout } from "@/components/setup/setup-callout";
import { guideFacts } from "@/lib/setup/facts";
import { buildGuide } from "@/lib/setup/guide";
import type { SetupEngines, SetupInput } from "@/components/settings/setup-model";
import { BrandGrid, type BrandLookup, type MachineState } from "@/components/home/brand-grid";
import { ActivityFeed } from "@/components/home/activity-feed";
import { CreateWorkspace } from "@/components/home/create-workspace";
import { attentionItems, homeKpis, isThinBrand, type ConnectionFact, type ReviewLoad } from "@/components/home/home-model";

export const Route = createFileRoute("/_app/")({ staticData: { pageTitle: "Overview" }, component: Home });

function Home() {
  const { data, loading, reload } = useWorkspace();
  const brandIds = data?.brands.map((brand) => brand.id) ?? [];
  const machines = useMachinesQuery(brandIds);
  const organizationId = data?.active?.id ?? "";
  const integrations = useIntegrationsQuery(organizationId, !!data?.active);
  const providers = useProviderSettingsQuery(organizationId, !!data?.active);
  const engines = useDecisionEnginesQuery(organizationId, !!data?.active);

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
  // The team reads the workspace's own job counts. Its art director also waits on the open reviews, which stay unknown until every brand loads.
  const team = teamStates({ jobs: data.overviewMetrics?.jobs ?? null, openReviews: reviews.status === "ready" ? reviews.total : null });

  // Every count is null until its data has loaded, so the setup steps say "could not be checked" rather than "to do".
  const setupSteps = buildGuide(guideFacts({
    brandCount: data.brands.length,
    summaries: (providers.data as SetupInput["summaries"] | undefined) ?? null,
    engines: (engines.data as SetupEngines | undefined) ?? null,
  }));
  const canCreate = hasRole(data.active.role, "member");

  return (
    <div className="space-y-10">
      <PageHeader
        title="Workspace overview"
        description={`A current view of ${data.active.name}, its brands, and work that needs attention.`}
        actions={canCreate ? <Button asChild variant="secondary"><Link to="/brands/new"><Plus aria-hidden="true" className="mr-2 size-4" />New brand</Link></Button> : undefined}
      />
      <KpiRow kpis={kpis} />
      <TeamPanel agents={team} />
      <AttentionList
        items={items}
        reviews={reviews}
        connections={connectionsState}
        onRetryReviews={() => { void Promise.all(machines.map((query) => query.refetch())); }}
        onRetryConnections={() => { void integrations.refetch(); }}
      />
      <SetupCallout steps={setupSteps} />
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
