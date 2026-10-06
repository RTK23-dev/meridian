import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useWorkspace } from "@/components/workspace";
import { Button, ErrorState, Notice, Panel, Skeleton, errorText } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getNotificationPreferences, setNotificationPreference } from "@/lib/meridian/observability/actions";
import { qk, userScopedQueryKey } from "@/lib/query/keys";

export const Route = createFileRoute("/notifications")({ component: NotificationsPage });

const TITLES: Record<string, string> = {
  "learning.update": "Learning updates",
  "performance.recorded": "Performance recorded",
  "review.required": "Review required",
  "integration.unavailable": "Integration unavailable",
};

function NotificationsPage() {
  const { user } = useCurrentUserState();
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryKey = userScopedQueryKey(user?.id, qk.notifications(organizationId));
  const query = useQuery({ queryKey, queryFn: () => getNotificationPreferences({ data: { organizationId } }), enabled: !!user && !!organizationId });
  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!query.data) return <div role="status" aria-label="Loading notification preferences"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  async function change(kind: string, enabled: boolean) {
    setPending(kind); setError(null);
    try {
      await setNotificationPreference({ data: { organizationId, kind, enabled } });
      await query.refetch();
    } catch (caught) { setError(errorText(caught)); }
    finally { setPending(null); }
  }
  return <div className="space-y-6">
    <header><p className="text-xs font-semibold uppercase tracking-widest text-brass">Workspace operations</p><h1 className="font-display text-4xl">Notification preferences</h1><p className="mt-2 max-w-2xl text-muted">Choose which in-app notifications appear for you in this workspace. These preferences do not control external webhook delivery.</p></header>
    {error ? <Notice>{error}</Notice> : null}
    <Panel><ul className="divide-y divide-line">{query.data.preferences.map(({ kind, enabled }) => <li key={kind} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"><div><p className="font-medium">{TITLES[kind] ?? kind}</p><p className="mt-1 text-sm text-muted">{enabled ? "Shown in your in-app workspace feed." : "Hidden from your in-app workspace feed."}</p></div><label className="flex min-h-11 items-center gap-3"><span className="text-sm">{enabled ? "On" : "Off"}</span><input type="checkbox" aria-label={`${TITLES[kind] ?? kind} notifications`} checked={enabled} disabled={pending !== null} onChange={(event) => void change(kind, event.target.checked)} /></label></li>)}</ul></Panel>
    {pending ? <p role="status" className="text-sm text-muted">Saving preference…</p> : <Button type="button" variant="quiet" onClick={() => void query.refetch()}>Refresh preferences</Button>}
  </div>;
}
