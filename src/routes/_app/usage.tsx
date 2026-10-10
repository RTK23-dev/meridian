import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/components/workspace";
import { ErrorState, Panel, Skeleton, errorText } from "@/components/ui";
import { listUsage } from "@/lib/meridian/jobs/actions";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { qk, userScopedQueryKey } from "@/lib/query/keys";

export const Route = createFileRoute("/_app/usage")({ component: UsagePage });

function UsagePage() {
  const { user } = useCurrentUserState();
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const query = useQuery({
    queryKey: userScopedQueryKey(user?.id, qk.usage(organizationId)),
    queryFn: () => listUsage({ data: { organizationId } }),
    enabled: !!user && !!organizationId,
  });
  if (query.error) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />;
  if (!query.data) return <div role="status" aria-label="Loading usage" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;

  const { usage, daily } = query.data;
  const money = usage.costCents == null ? "Cost unknown" : formatMoney(usage.costCents);
  return <div className="space-y-6">
    <header><p className="text-xs font-semibold uppercase tracking-widest text-brass">Workspace operations</p><h1 className="font-display text-4xl">Usage &amp; cost</h1><p className="mt-2 max-w-2xl text-muted">Recorded model usage for this workspace. Costs remain unknown when a run did not report a cost.</p></header>
    <div className="grid gap-3 sm:grid-cols-3">
      <Metric label="Recorded runs" value={query.data.runs.toLocaleString()} />
      <Metric label="Tokens" value={usage.tokens.toLocaleString()} />
      <Metric label="Recorded cost" value={money} />
    </div>
    <section aria-labelledby="operation-title" className="space-y-3"><h2 id="operation-title" className="font-display text-2xl">By operation</h2>
      {query.data.byOperation.length ? <div className="overflow-x-auto rounded-lg border border-line"><table className="w-full min-w-[28rem] text-left text-sm"><thead className="bg-paper text-muted"><tr><th className="px-4 py-3 font-medium">Operation</th><th className="px-4 py-3 text-right font-medium">Tokens</th><th className="px-4 py-3 text-right font-medium">Cost</th></tr></thead><tbody>{query.data.byOperation.map((row) => <tr key={row.operation} className="border-t border-line"><th scope="row" className="px-4 py-3 font-medium">{row.operation}</th><td className="px-4 py-3 text-right tabular-nums">{row.tokens.toLocaleString()}</td><td className="px-4 py-3 text-right tabular-nums">{row.costCents == null ? "Cost unknown" : formatMoney(row.costCents)}</td></tr>)}</tbody></table></div> : <Panel>No model usage is recorded for this workspace.</Panel>}
    </section>
    <section aria-labelledby="daily-title" className="space-y-3"><h2 id="daily-title" className="font-display text-2xl">Daily usage</h2>
      {daily.length ? <div className="overflow-x-auto rounded-lg border border-line"><table className="w-full min-w-[32rem] text-left text-sm"><thead className="bg-paper text-muted"><tr><th className="px-4 py-3 font-medium">Day</th><th className="px-4 py-3 text-right font-medium">Tokens</th><th className="px-4 py-3 text-right font-medium">Cost</th></tr></thead><tbody>{daily.map((row) => <tr key={row.day} className="border-t border-line"><th scope="row" className="px-4 py-3 font-medium">{row.day}</th><td className="px-4 py-3 text-right tabular-nums">{row.tokens.toLocaleString()}</td><td className="px-4 py-3 text-right tabular-nums">{row.costCents == null ? "Cost unknown" : formatMoney(row.costCents)}</td></tr>)}</tbody></table></div> : <Panel>No daily usage is recorded for this workspace.</Panel>}
    </section>
    {usage.missingCost > 0 ? <p className="text-sm text-muted">{usage.missingCost.toLocaleString()} run{usage.missingCost === 1 ? " has" : "s have"} no recorded cost; totals that include them are shown as unknown.</p> : null}
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <Panel><p className="text-sm text-muted">{label}</p><p className="mt-2 font-display text-3xl tabular-nums">{value}</p></Panel>;
}

function formatMoney(cents: number) {
  return `${cents.toLocaleString()} cents`;
}
