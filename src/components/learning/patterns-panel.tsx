import type { ColumnDef } from "@tanstack/react-table";
import { CircleHelp, Minus, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, DataTable, EmptyState } from "@/components/ui";
import { PlainErrorNotice, TechnicalDetails } from "@/components/plain-error";
import { copy, decisionOutcome, percentOrUnknown } from "@/lib/copy";
import type { getLearning } from "@/lib/meridian/machine";
import { refreshLearning } from "@/lib/meridian/machine";
import { useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { ChartFigure, ValueBarChart, ValueTable } from "./charts";
import { NOT_ENOUGH_RESULTS } from "./metrics";
import { formatSignedPercent, hasSample, patternDisplay, type PatternDisplay } from "./lift";

export type LearningData = Awaited<ReturnType<typeof getLearning>>;

const directionIcon: Record<PatternDisplay["direction"], LucideIcon> = {
  POSITIVE: TrendingUp,
  NEGATIVE: TrendingDown,
  NEUTRAL: Minus,
  INSUFFICIENT_EVIDENCE: CircleHelp,
};

const directionVariant: Record<PatternDisplay["direction"], "success" | "danger" | "neutral" | "warning"> = {
  POSITIVE: "success",
  NEGATIVE: "danger",
  NEUTRAL: "neutral",
  INSUFFICIENT_EVIDENCE: "warning",
};

/** Direction is shown as an icon and text, never as colour alone. */
export function DirectionBadge({ display }: { display: PatternDisplay }) {
  const Icon = directionIcon[display.direction];
  return <Badge variant={directionVariant[display.direction]}>
    <Icon aria-hidden="true" className="size-3.5" />
    <span>{display.directionLabel}</span>
  </Badge>;
}

type PatternRow = {
  id: string;
  title: string;
  metric: string;
  scope: string;
  display: PatternDisplay;
  sampleSize: number;
  impressions: number;
  liftValue: number;
};

export function PatternsPanel({ brandId, data, canEdit }: { brandId: string; data: LearningData; canEdit: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const recompute = useScopedMutation({
    mutationKey: ["mutation", "learning.recompute", brandId],
    mutationFn: () => refreshLearning({ data: { brandId } }),
    // Recomputing rewrites the stored patterns, which studio and the brand overview read.
    invalidate: () => [qk.learning(brandId), qk.studio(brandId), qk.machine(brandId)],
    onSuccess: (result) => setNote(result.patterns === 0 ? copy.learning.noPatternStored : copy.learning.patternsStored(result.patterns)),
  });

  const rows: PatternRow[] = data.patterns.map((pattern) => ({
    id: pattern.id,
    title: `${pattern.attribute}: ${pattern.value}`,
    metric: pattern.metric,
    scope: pattern.scope,
    display: patternDisplay({ lift: pattern.lift, sampleSize: pattern.sampleSize, impressions: pattern.impressions, state: pattern.state }),
    sampleSize: pattern.sampleSize,
    impressions: pattern.impressions,
    liftValue: pattern.lift,
  }));

  const columns: ColumnDef<PatternRow, unknown>[] = [
    { id: "pattern", header: "Pattern", enableSorting: false, cell: ({ row }) => <span><span className="block font-semibold">{row.original.title}</span><span className="block text-xs text-fg-muted">{row.original.metric} · {row.original.scope === "organization" ? "Shared with this workspace" : "This brand"}</span></span> },
    { id: "direction", header: "Direction", enableSorting: false, cell: ({ row }) => <DirectionBadge display={row.original.display} /> },
    { id: "state", header: "State", enableSorting: false, cell: ({ row }) => row.original.display.stateText },
    { accessorKey: "sampleSize", header: "Creatives", cell: ({ row }) => hasSample(row.original.sampleSize) ? row.original.sampleSize.toLocaleString() : NOT_ENOUGH_RESULTS },
    { accessorKey: "impressions", header: "Impressions", cell: ({ row }) => hasSample(row.original.impressions) ? row.original.impressions.toLocaleString() : NOT_ENOUGH_RESULTS },
    { accessorKey: "liftValue", header: "Lift vs baseline", cell: ({ row }) => row.original.display.liftText },
  ];
  const anyInterval = rows.some((row) => row.display.intervalText !== null);
  if (anyInterval) {
    columns.push({ id: "interval", header: "Interval", enableSorting: false, cell: ({ row }) => row.original.display.intervalText ?? "Not stored" });
  }

  const chartData = data.patterns.slice(0, 8).map((pattern, index) => {
    const display = rows[index].display;
    return { label: `${pattern.attribute}: ${pattern.value}`, value: display.hasEvidence ? pattern.lift : null };
  });
  const chartSummary = `Stored lift for the first ${chartData.length} patterns: ${chartData.map((item) => `${item.label} ${item.value === null ? NOT_ENOUGH_RESULTS : formatSignedPercent(item.value)}`).join("; ")}.`;

  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-section font-semibold">Stored patterns</h2>
        <p className="text-sm text-fg-muted">Patterns are what the opportunity ranking can use. Each one needs enough creatives and impressions before it is stored.</p>
      </div>
      {canEdit ? <Button type="button" disabled={recompute.isPending} onClick={() => void recompute.mutateAsync().catch(() => undefined)}>Recompute patterns</Button> : null}
    </div>
    {note ? <p role="status" className="text-sm text-fg-muted">{note}</p> : null}
    {recompute.error ? <PlainErrorNotice error={recompute.error} /> : null}

    {data.patterns.length === 0 ? (
      <EmptyState
        title="No learned patterns yet"
        reason="Enter performance on at least three creatives that share an attribute, with 300 impressions in that bucket, then recompute. CTR, conversion rate, and ROAS are calculated from those rows. Nothing is filled in for you."
      />
    ) : (
      <>
        <ChartFigure
          id="stored-lift"
          title="Stored lift by attribute"
          description="Lift is relative to the brand baseline. Gaps mean not enough results for that pattern."
          summary={chartSummary}
          table={<ValueTable caption="Stored lift for the first eight patterns" headers={["Pattern", "Lift vs baseline"]} rows={chartData.map((item) => [item.label, item.value === null ? NOT_ENOUGH_RESULTS : formatSignedPercent(item.value)])} />}
        >
          <ValueBarChart data={chartData} name="Stored lift" format={(value) => formatSignedPercent(value)} />
        </ChartFigure>
        <Card className="space-y-3">
          <h3 className="text-base font-semibold">All stored patterns</h3>
          <DataTable data={rows} columns={columns} getRowId={(row) => row.id} emptyTitle="No learned patterns yet" emptyReason="Recompute patterns after enough performance rows are stored." />
          {anyInterval ? null : <p className="text-sm text-fg-muted">No confidence intervals are stored for these patterns, so none are shown.</p>}
        </Card>
      </>
    )}

    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h3 className="text-base font-semibold">Rejections</h3>
        {data.rejections.length === 0 ? <p className="mt-2 text-sm text-fg-muted">No stored rejections.</p> : (
          <ul className="mt-3 space-y-1 text-sm">
            {data.rejections.map((item) => <li key={item.reasonCode}>{item.reasonCode.replaceAll("_", " ")} · {item.count}</li>)}
          </ul>
        )}
      </Card>
      <Card>
        <h3 className="text-base font-semibold">Decision log</h3>
        {data.decisions.length === 0 ? <p className="mt-2 text-sm text-fg-muted">No decisions yet.</p> : (
          <ul className="mt-3 space-y-3 text-sm">
            {data.decisions.map((item) => (
              <li key={item.id}>
                <span className="font-semibold">{decisionOutcome(item.decision)}</span> · {item.question} · {item.subject} · probability {percentOrUnknown(item.probability)}
                <span className="block text-fg-muted">{item.reasons[0]}</span>
                <TechnicalDetails>Decision code {item.decision}</TechnicalDetails>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  </div>;
}

