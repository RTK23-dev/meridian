import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/cn";

export type TraitRow = { trait: string; count: number };

/** Turns stored trait counts into chart rows. Non-finite counts are dropped rather than drawn as zero. */
export function traitRows(traits: Record<string, number>): TraitRow[] {
  return Object.entries(traits)
    .filter(([, count]) => Number.isFinite(count))
    .map(([trait, count]) => ({ trait: trait.replace(/_/g, " "), count }))
    .sort((left, right) => right.count - left.count || left.trait.localeCompare(right.trait));
}

/**
 * A small horizontal bar chart of stored trait counts. The chart has a text alternative: its aria-label lists the values,
 * and a visually hidden table repeats them for screen readers that read tables.
 */
export function TraitBarChart({ title, description, rows, tone }: {
  title: string;
  description: string;
  rows: TraitRow[];
  tone: "success" | "danger";
}) {
  if (rows.length === 0) return null;
  const height = Math.max(120, rows.length * 36 + 40);
  const summary = rows.map((row) => `${row.trait} ${row.count}`).join(", ");
  return <figure className="space-y-2">
    <figcaption className="text-sm font-semibold">{title}</figcaption>
    <div role="img" aria-label={`${title}: ${summary}`} style={{ height }} className={cn("w-full", tone === "success" ? "text-success" : "text-danger")}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
          <CartesianGrid horizontal={false} strokeOpacity={0.2} />
          <XAxis type="number" allowDecimals={false} tick={{ fill: "currentColor", fontSize: 12 }} />
          <YAxis type="category" dataKey="trait" width={140} tick={{ fill: "currentColor", fontSize: 12 }} />
          <Tooltip contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-fg)", borderRadius: 6, fontSize: 12 }} labelStyle={{ color: "var(--color-fg)" }} itemStyle={{ color: "var(--color-fg)" }} />
          <Bar dataKey="count" name="Count" fill="currentColor" radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
    <table className="sr-only">
      <caption>{title}</caption>
      <thead><tr><th scope="col">Trait</th><th scope="col">Count</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.trait}><th scope="row">{row.trait}</th><td>{row.count}</td></tr>)}</tbody>
    </table>
    <p className="text-xs text-fg-muted">{description}</p>
  </figure>;
}
