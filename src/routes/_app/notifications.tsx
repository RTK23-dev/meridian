import { createFileRoute } from "@tanstack/react-router";
import { Button, Card, PageHeader, ScreenSkeleton } from "@/components/ui";
import { PlainErrorNotice, PlainErrorState } from "@/components/plain-error";
import { useWorkspace } from "@/components/workspace";
import { setNotificationPreference } from "@/lib/meridian/observability/actions";
import { qk } from "@/lib/query/keys";
import { useNotificationPreferencesQuery, usePendingVariables, useScopedMutation } from "@/lib/query/hooks";

export const Route = createFileRoute("/_app/notifications")({ staticData: { pageTitle: "Notification preferences" }, component: NotificationsPage });

const TITLES: Record<string, string> = {
  "learning.update": "Learning updates",
  "performance.recorded": "Performance recorded",
  "review.required": "Review required",
  "integration.unavailable": "Integration unavailable",
};

function NotificationsPage() {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const query = useNotificationPreferencesQuery(organizationId);
  const changeKey = ["mutation", "notifications.change", organizationId] as const;
  const change = useScopedMutation({
    mutationKey: changeKey,
    mutationFn: (vars: { kind: string; enabled: boolean }) => setNotificationPreference({ data: { organizationId, kind: vars.kind, enabled: vars.enabled } }),
    invalidate: () => [qk.notifications(organizationId)],
    success: "Notification preference saved.",
  });
  // Only the preference being saved is disabled, so the other switches stay usable.
  const saving = usePendingVariables<{ kind: string; enabled: boolean }>(changeKey).map((vars) => vars.kind);
  if (query.isError && !query.data) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <ScreenSkeleton label="Loading notification preferences" shape="rows" />;
  return <div className="space-y-6">
    <PageHeader title="Notification preferences" description="Choose which in-app notifications appear for you in this workspace. These preferences do not control external webhook delivery." />
    {change.error ? <PlainErrorNotice error={change.error} /> : null}
    <Card><ul className="divide-y divide-border">{query.data.preferences.map(({ kind, enabled }) => <li key={kind} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"><div><p className="font-medium">{TITLES[kind] ?? kind}</p><p className="mt-1 text-sm text-fg-muted">{enabled ? "Shown in your in-app workspace feed." : "Hidden from your in-app workspace feed."}</p></div><label className="flex min-h-11 items-center gap-3"><span className="text-sm">{enabled ? "On" : "Off"}</span><input type="checkbox" className="size-6 accent-accent" aria-label={`${TITLES[kind] ?? kind} notifications`} checked={enabled} disabled={saving.includes(kind)} onChange={(event) => void change.mutateAsync({ kind, enabled: event.target.checked }).catch(() => undefined)} /></label></li>)}</ul></Card>
    {saving.length > 0 ? <p role="status" className="text-sm text-fg-muted">Saving preference…</p> : <Button type="button" variant="quiet" onClick={() => void query.refetch()}>Refresh preferences</Button>}
  </div>;
}
