import type { ReactNode } from "react";
import { Activity, BarChart3, Clock3, ServerCrash, Sparkles } from "lucide-react";
import { KpiCard, Skeleton } from "@/components/ui";
import type { KpiId, KpiSpec } from "./home-model";

const ICONS: Record<KpiId, ReactNode> = {
  brands: <Sparkles aria-hidden="true" className="size-5" />,
  openReviews: <Clock3 aria-hidden="true" className="size-5" />,
  failedJobs: <ServerCrash aria-hidden="true" className="size-5" />,
  livePublications: <BarChart3 aria-hidden="true" className="size-5" />,
  lastSync: <Activity aria-hidden="true" className="size-5" />,
};

/** Renders only the cards the model returns. A card with a null value is still loading, and shows a skeleton. */
export function KpiRow({ kpis }: { kpis: KpiSpec[] }) {
  return (
    <section aria-label="Workspace metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {kpis.map((kpi) => kpi.value === null
        ? <KpiLoading key={kpi.id} label={kpi.label} />
        : <KpiCard key={kpi.id} label={kpi.label} value={kpi.value} description={kpi.description} icon={ICONS[kpi.id]} />)}
    </section>
  );
}

function KpiLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={`Loading ${label}`} className="rounded-lg border border-border bg-surface p-4">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="mt-4 h-8 w-16" />
      <Skeleton className="mt-3 h-3 w-32" />
    </div>
  );
}
