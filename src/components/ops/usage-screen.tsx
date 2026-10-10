import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, PageHeader, ScreenSkeleton } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { useUsageQuery } from "@/lib/query/hooks";
import { AdminOnlyNotice, MetricCard } from "./ops-shared";
import { barPercent, costNote, dayLabel, formatCostCents, tokensLabel, truncationNote } from "./usage-model";

type UsageGroup = { runs: number; tokens: number; costCents: number | null; missingCost: number; missingTokens: number };

export function UsageScreen() {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const role = workspace?.active?.role ?? "viewer";
  const canAdmin = hasRole(role, "admin");
  const query = useUsageQuery(organizationId, canAdmin && !!organizationId);

  if (!workspace?.active) return null;
  if (!canAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Usage & cost" description="Model runs recorded for this workspace." />
        <AdminOnlyNotice screen="Usage and cost" role={role} />
      </div>
    );
  }
  if (query.isError && !query.data) return <PlainErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <ScreenSkeleton label="Loading usage and cost" shape="cards" />;

  const { usage, runs, truncated, rowLimit, byOperation, daily } = query.data;
  const maxOperationTokens = Math.max(0, ...byOperation.map((row) => row.tokens));
  const maxDayTokens = Math.max(0, ...daily.map((row) => row.tokens));
  const costDetail = costNote(usage.missingCost) ?? "Summed from every run in the workspace.";

  function groupColumns<T extends UsageGroup>(label: string, max: number, nameOf: (row: T) => string): ColumnDef<T, unknown>[] {
    return [
      { id: "name", header: label, enableSorting: false, cell: ({ row }) => <span className="font-medium break-words">{nameOf(row.original)}</span> },
      { id: "runs", header: "Runs", enableSorting: false, cell: ({ row }) => row.original.runs.toLocaleString() },
      {
        id: "tokens",
        header: "Tokens",
        enableSorting: false,
        cell: ({ row }) => <TokenCell tokens={row.original.tokens} missingTokens={row.original.missingTokens} max={max} />,
      },
      {
        id: "cost",
        header: "Cost",
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <span className="tabular-nums">{formatCostCents(row.original.costCents)}</span>
            {costNote(row.original.missingCost) ? <p className="text-xs text-fg-muted">{row.original.missingCost.toLocaleString()} without a cost</p> : null}
          </div>
        ),
      },
    ];
  }

  const operationColumns = groupColumns<(typeof byOperation)[number]>("Operation", maxOperationTokens, (row) => row.operation);
  const dayColumns = groupColumns<(typeof daily)[number]>("Day (UTC)", maxDayTokens, (row) => dayLabel(row.day));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Usage & cost"
        description="Model runs recorded for this workspace. A cost a run did not report stays unknown. It is never counted as zero."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard
          label="Recorded runs"
          value={runs.toLocaleString()}
          detail={truncationNote(truncated, rowLimit) ?? undefined}
        />
        <MetricCard
          label="Tokens"
          value={tokensLabel(usage.tokens, usage.missingTokens)}
          detail={usage.missingTokens > 0 ? `${usage.missingTokens.toLocaleString()} runs have no token count.` : "Summed from the runs that recorded tokens."}
        />
        <MetricCard label="Cost" value={formatCostCents(usage.costCents)} detail={costDetail} />
      </div>

      <section aria-labelledby="operation-heading" className="space-y-3">
        <h2 id="operation-heading" className="text-section font-semibold">By operation</h2>
        <DataTable
          data={byOperation}
          columns={operationColumns}
          getRowId={(row) => row.operation}
          emptyTitle="No model runs are recorded yet"
          emptyReason="Usage appears here after the workspace runs a model."
        />
      </section>

      <section aria-labelledby="daily-heading" className="space-y-3">
        <h2 id="daily-heading" className="text-section font-semibold">By day</h2>
        <p className="text-sm text-fg-muted">The newest 90 days with recorded runs, in UTC.</p>
        <DataTable
          data={daily}
          columns={dayColumns}
          getRowId={(row) => row.day}
          emptyTitle="No daily usage is recorded yet"
          emptyReason="Each day with a recorded model run appears here."
        />
      </section>
    </div>
  );
}

/** A token count with a bar drawn only when the count and the largest count on screen are both real numbers. */
function TokenCell({ tokens, missingTokens, max }: { tokens: number; missingTokens: number; max: number }) {
  const percent = barPercent(tokens, max);
  return (
    <div className="flex min-w-32 items-center gap-3">
      <span className="tabular-nums">{tokensLabel(tokens, missingTokens)}</span>
      {percent !== null ? (
        <span aria-hidden="true" className="block h-2 flex-1 rounded-full bg-surface-2">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        </span>
      ) : null}
    </div>
  );
}
