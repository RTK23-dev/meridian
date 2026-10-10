import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip } from "recharts";
import { scoreSummary, type ScoreDimension } from "./opportunity-model";

type ChartDatum = { name: string; value: number | null; effect: ScoreDimension["effect"]; explanation: string };

/** The tooltip explains the number under the pointer. Unknown parts show as Unknown, not as a point at zero. */
function DimensionTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: ChartDatum }> }) {
  const datum = payload?.[0]?.payload;
  if (!active || !datum) return null;
  const effect = datum.effect === "adds" ? "Adds to the rank" : "Subtracts from the rank";
  return <div className="max-w-64 rounded bg-fg px-3 py-2 text-xs text-bg shadow-sm">
    <p className="font-semibold">{datum.name}: {datum.value === null ? "Unknown" : datum.value.toFixed(2)}</p>
    <p className="mt-1">{datum.explanation}</p>
    <p className="mt-1 opacity-80">{effect}.</p>
  </div>;
}

/**
 * The rank explained as a radar of its seven parts. A radar is used instead of a stacked bar because the parts do not
 * add up to the rank: two of them are subtracted and the weights are not returned to this screen.
 * The chart has a text alternative (its aria-label and the list of values the sheet shows beside it).
 */
export function ScoreRadar({ dimensions, label }: { dimensions: ScoreDimension[]; label: string }) {
  const data: ChartDatum[] = dimensions.map((dimension) => ({ name: dimension.label, value: dimension.value, effect: dimension.effect, explanation: dimension.explanation }));
  return <div role="img" aria-label={`${label}. ${scoreSummary(dimensions)}`} className="h-64 w-full text-accent">
    <ResponsiveContainer width="100%" height="100%">
      <RadarChart data={data} outerRadius="72%">
        <PolarGrid stroke="currentColor" strokeOpacity={0.25} />
        <PolarAngleAxis dataKey="name" tick={{ fill: "currentColor", fontSize: 12 }} />
        <PolarRadiusAxis domain={[0, 1]} tickCount={3} tick={{ fill: "currentColor", fontSize: 10 }} stroke="currentColor" strokeOpacity={0.25} />
        <Radar dataKey="value" stroke="currentColor" fill="currentColor" fillOpacity={0.2} connectNulls={false} isAnimationActive={false} />
        <Tooltip content={<DimensionTooltip />} />
      </RadarChart>
    </ResponsiveContainer>
  </div>;
}
