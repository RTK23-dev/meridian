import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useMediaQuery } from "@/lib/use-media-query";
import type { LearningRow } from "./learning-rows.ts";

type TooltipPayload = { payload?: LearningRow };

/** Lift, sample size and impressions for one pattern. Text, so the numbers do not depend on the bar's colour. */
function PatternTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-md border border-border bg-surface p-2 text-xs text-fg shadow-md">
      <p className="font-semibold">{row.label}</p>
      <p>Lift {row.lift.toFixed(2)} · {row.direction.toLowerCase()} · {row.state.toLowerCase()}</p>
      <p>Sample size {row.sampleSize} · {row.impressions} impressions</p>
    </div>
  );
}

/**
 * Learned patterns as bars, ordered by lift. Positive lift is drawn in the accent colour and negative lift in the danger
 * colour. The direction is also written in the tooltip and the text list, so colour is not the only signal.
 */
export default function LearningBars({ rows }: { rows: LearningRow[] }) {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const height = Math.max(160, rows.length * 40 + 48);
  return (
    <div role="img" aria-label={`Bar chart of ${rows.length} learned patterns by lift. The same values are listed below.`} style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 12 }} />
          <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 12 }} />
          <Tooltip content={PatternTooltip} />
          <Bar dataKey="lift" name="Lift" isAnimationActive={!reduceMotion}>
            {rows.map((row) => (
              <Cell key={row.key} fill={row.lift >= 0 ? "var(--color-accent)" : "var(--color-danger)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
