import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useMediaQuery } from "@/lib/use-media-query";
import { NOT_ENOUGH_RESULTS } from "./metrics";

/**
 * The recharts plots for the learning screen. Only this module imports recharts. The learning charts reach it through
 * React.lazy (see charts.tsx), so the library loads when the first plot is shown.
 */

const tooltipStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, color: "var(--color-fg)", fontSize: 12 };

export type ChartDatum = { label: string; value: number | null };
export type ChartPlotProps = { data: ChartDatum[]; name: string; format: (value: number) => string };

/** Bars with a null value are left out of the plot, not drawn at zero. Bars animate unless the reader asked for less motion. */
export function ValueBarPlot({ data, name, format }: ChartPlotProps) {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  return <ResponsiveContainer width="100%" height="100%">
    <BarChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 40 }}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="label" interval={0} angle={-24} textAnchor="end" height={64} tick={{ fontSize: 11 }} />
      <YAxis tickFormatter={(value: number) => format(value)} width={64} />
      <Tooltip contentStyle={tooltipStyle} formatter={(value) => (typeof value === "number" ? format(value) : NOT_ENOUGH_RESULTS)} />
      <Bar dataKey="value" name={name} fill="currentColor" radius={[4, 4, 0, 0]} isAnimationActive={!reduceMotion} />
    </BarChart>
  </ResponsiveContainer>;
}

/** The line breaks at a null value, so a day with no impressions reads as a gap. */
export function ValueLinePlot({ data, name, format }: ChartPlotProps) {
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
