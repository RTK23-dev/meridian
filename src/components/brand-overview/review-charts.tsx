import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui";
import { useMediaQuery } from "@/lib/use-media-query";

/** Chart colours come from the theme tokens. Fills use currentColor, set on the wrapper, and axis text uses fg-muted. */
const tooltipStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, color: "var(--color-fg)", fontSize: 12 };

type Bin = { range: string; count: number };

/** Opportunity rank distribution from stored expected values. Renders nothing when no open opportunity has a stored value. */
export function OpportunityChart({ rows }: { rows: Array<{ expectedValue: number; status: string }> }) {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const open = rows.filter((row) => row.status === "open");
  if (!open.length) return null;
  const bins: Bin[] = [
    { range: "0–0.25", count: open.filter((row) => row.expectedValue < 0.25).length },
    { range: "0.25–0.5", count: open.filter((row) => row.expectedValue >= 0.25 && row.expectedValue < 0.5).length },
    { range: "0.5–0.75", count: open.filter((row) => row.expectedValue >= 0.5 && row.expectedValue < 0.75).length },
    { range: "0.75–1", count: open.filter((row) => row.expectedValue >= 0.75).length },
  ];
  return (
    <ChartPanel
      title="Open opportunity rank distribution"
      description="Stored JEV expected-value scores"
      label="Open opportunities grouped by stored expected value"
      bins={bins}
      unit="opportunities"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bins} margin={{ left: -20, right: 8, top: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="range" />
          <YAxis allowDecimals={false} />
          <Tooltip cursor={{ fill: "currentColor", fillOpacity: 0.08 }} contentStyle={tooltipStyle} />
          <Bar dataKey="count" name="Opportunities" fill="currentColor" radius={[4, 4, 0, 0]} isAnimationActive={!reduceMotion}>
            {bins.map((entry) => <Cell key={entry.range} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

/** Age of open reviews from stored timestamps. Renders nothing when no review is open. */
export function ReviewAgeChart({ rows }: { rows: Array<{ status: string; createdAt: string }> }) {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const open = rows.filter((row) => row.status === "open");
  if (!open.length) return null;
  const now = Date.now();
  const day = 86_400_000;
  const bins: Bin[] = [
    { range: "< 1 day", count: open.filter((row) => now - Date.parse(row.createdAt) < day).length },
    { range: "1–7 days", count: open.filter((row) => { const age = now - Date.parse(row.createdAt); return age >= day && age < 7 * day; }).length },
    { range: "> 7 days", count: open.filter((row) => now - Date.parse(row.createdAt) >= 7 * day).length },
  ];
  return (
    <ChartPanel title="Review queue age" description="Age from stored open-review timestamps" label="Open reviews grouped by age" bins={bins} unit="open reviews">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bins} margin={{ left: -20, right: 8, top: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="range" />
          <YAxis allowDecimals={false} />
          <Tooltip cursor={{ fill: "currentColor", fillOpacity: 0.08 }} contentStyle={tooltipStyle} />
          <Bar dataKey="count" name="Open reviews" fill="currentColor" radius={[4, 4, 0, 0]} isAnimationActive={!reduceMotion} />
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

function ChartPanel({ title, description, label, bins, unit, children }: {
  title: string;
  description: string;
  label: string;
  bins: Bin[];
  unit: string;
  children: ReactNode;
}) {
  const summary = bins.map((bin) => `${bin.range}: ${bin.count}`).join(", ");
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        <p className="text-sm text-fg-muted">{description}</p>
      </div>
      <div role="img" aria-label={`${label}. ${summary} ${unit}.`} className="h-52 text-accent [&_.recharts-cartesian-axis-tick-value]:fill-fg-muted [&_line]:stroke-border">
        {children}
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        {bins.map((bin) => (
          <div key={bin.range} className="rounded-md bg-surface-2 px-2 py-1.5">
            <dt className="text-fg-muted">{bin.range}</dt>
            <dd className="font-semibold text-fg">{bin.count}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
