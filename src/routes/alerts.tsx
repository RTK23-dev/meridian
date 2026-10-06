import { createFileRoute } from "@tanstack/react-router";
import { AlertsPanel } from "@/components/alerts-panel";
import { useWorkspace } from "@/components/workspace";
import { Panel, Skeleton } from "@/components/ui";

export const Route = createFileRoute("/alerts")({ component: AlertsPage });

function AlertsPage() {
  const { data } = useWorkspace();
  const organization = data?.active;
  if (!organization) return <div role="status" aria-label="Loading alerts"><Skeleton variant="line" /></div>;
  return <div className="space-y-6">
    <header><p className="text-xs font-semibold uppercase tracking-widest text-brass">Workspace operations</p><h1 className="font-display text-4xl">Alerts center</h1><p className="mt-2 max-w-2xl text-muted">Review stored system alerts, acknowledge resolved items, and configure an HTTPS delivery target.</p></header>
    <AlertsPanel organizationId={organization.id} />
    <Panel><p className="text-sm text-muted">Delivery is reported only after the configured endpoint accepts the event. A saved target is not a delivery confirmation.</p></Panel>
  </div>;
}
