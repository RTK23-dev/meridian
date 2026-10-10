import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/cn";
import { NOT_ENOUGH_RESULTS } from "./metrics";

const tooltipStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, color: "var(--color-fg)", fontSize: 12 };
const plotClass = "h-56 w-full text-accent [&_.recharts-cartesian-axis-tick-value]:fill-fg-muted [&_line]:stroke-border";

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

export type ChartDatum = { label: string; value: number | null };

/** Bars with a null value are left out of the plot, not drawn at zero. */
export function ValueBarChart({ data, name, format }: { data: ChartDatum[]; name: string; format: (value: number) => string }) {
  return <ResponsiveContainer width="100%" height="100%">
    <BarChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 40 }}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="label" interval={0} angle={-24} textAnchor="end" height={64} tick={{ fontSize: 11 }} />
      <YAxis tickFormatter={(value: number) => format(value)} width={64} />
      <Tooltip contentStyle={tooltipStyle} formatter={(value) => (typeof value === "number" ? format(value) : NOT_ENOUGH_RESULTS)} />
      <Bar dataKey="value" name={name} fill="currentColor" radius={[4, 4, 0, 0]} />
    </BarChart>
  </ResponsiveContainer>;
}

/** The line breaks at a null value, so a day with no impressions reads as a gap. */
export function ValueLineChart({ data, name, format }: { data: ChartDatum[]; name: string; format: (value: number) => string }) {
  return <ResponsiveContainer width="100%" height="100%">
    <LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 8 }}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
      <YAxis tickFormatter={(value: number) => format(value)} width={64} />
      <Tooltip contentStyle={tooltipStyle} formatter={(value) => (typeof value === "number" ? format(value) : NOT_ENOUGH_RESULTS)} />
      <Line dataKey="value" name={name} stroke="currentColor" strokeWidth={2} dot connectNulls={false} isAnimationActive={false} />
    </LineChart>
  </ResponsiveContainer>;
}
