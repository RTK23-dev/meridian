import { lazy, Suspense, type ReactNode } from "react";
import { ChartSkeleton } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { ChartPlotProps } from "./chart-plots";

export type { ChartDatum } from "./chart-plots";

const plotClass = "h-56 w-full text-accent [&_.recharts-cartesian-axis-tick-value]:fill-fg-muted [&_line]:stroke-border";

// recharts is in chart-plots.tsx and loads with the first plot. The skeleton fills the plot's box until then.
const ValueBarPlot = lazy(() => import("./chart-plots").then((module) => ({ default: module.ValueBarPlot })));
const ValueLinePlot = lazy(() => import("./chart-plots").then((module) => ({ default: module.ValueLinePlot })));

/**
 * A chart with a text alternative. The plot is labelled with a summary sentence, and the table beside it
 * carries every value (including "Not enough results" gaps), so no chart is the only source of a number.
 */
export function ChartFigure({ id, title, description, summary, table, children }: {
  id: string;
  title: string;
  description: string;
  summary: string;
  table: ReactNode;
  children: ReactNode;
}) {
  return <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-lg border border-border bg-surface p-5">
    <div className="space-y-1">
      <h3 id={`${id}-title`} className="text-base font-semibold text-fg">{title}</h3>
      <p className="text-sm text-fg-muted">{description}</p>
    </div>
    <div role="img" aria-label={summary} className={plotClass}>{children}</div>
    <div className="overflow-x-auto">{table}</div>
  </section>;
}

/** The text alternative for a chart: every value as a row, with "Not enough results" written out. */
export function ValueTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: string[][] }) {
  return <table className="w-full min-w-64 border-collapse text-left text-sm">
    <caption className="sr-only">{caption}</caption>
    <thead className="bg-surface-2 text-fg-muted">
      <tr>{headers.map((header, index) => <th key={`${header}-${index}`} scope="col" className={cn("border-b border-border px-3 py-2 font-semibold", index > 0 && "text-right")}>{header}</th>)}</tr>
    </thead>
    <tbody>
      {rows.map((cells, rowIndex) => <tr key={rowIndex}>
        {cells.map((cell, cellIndex) => cellIndex === 0
          ? <th key={cellIndex} scope="row" className="border-b border-border px-3 py-2 text-left font-normal">{cell}</th>
          : <td key={cellIndex} className="border-b border-border px-3 py-2 text-right tabular-nums">{cell}</td>)}
      </tr>)}
    </tbody>
  </table>;
}

/** Bars for one chart. A null value is left out of the plot, not drawn at zero. */
export function ValueBarChart(props: ChartPlotProps) {
  return <Suspense fallback={<ChartSkeleton />}><ValueBarPlot {...props} /></Suspense>;
}

/** A line for one chart. A null value breaks the line. */
export function ValueLineChart(props: ChartPlotProps) {
  return <Suspense fallback={<ChartSkeleton />}><ValueLinePlot {...props} /></Suspense>;
}
