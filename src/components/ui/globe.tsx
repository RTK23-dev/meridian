import { cn } from "./cn";

/** Meridians at these angles when still. Each one turns through a full cycle, so the still globe is one frame of that cycle. */
const MERIDIANS = [10, 40, 70, 100];
const RED = 1;
const TURN_MS = 2400;

/** The meridian globe: an outline, three latitudes and four meridians. The red meridian carries a comet while animated. */
export function GlobeSvg({ size, animated = false }: { size: number; animated?: boolean }) {
  const weight = size <= 16 ? 2 : size <= 24 ? 1.5 : 1.1;
  return <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false" className="shrink-0">
    <circle cx="24" cy="24" r="22" className="globe-ink" strokeWidth={weight * 1.3} />
    <ellipse cx="24" cy="13" rx="19.05" ry="4.76" className="globe-ink" strokeWidth={weight} />
    <ellipse cx="24" cy="24" rx="22" ry="5.5" className="globe-ink" strokeWidth={weight} />
    <ellipse cx="24" cy="35" rx="19.05" ry="4.76" className="globe-ink" strokeWidth={weight} />
    {MERIDIANS.map((degrees, index) => {
      const red = index === RED;
      return <g key={degrees} className={cn("globe-meridian", animated && "globe-turn")} style={{ transform: `scaleX(${Math.cos((degrees * Math.PI) / 180).toFixed(4)})`, animationDelay: `${(-(degrees / 360) * TURN_MS).toFixed(1)}ms` }}>
        <circle cx="24" cy="24" r="22" className={red ? "globe-red" : "globe-ink"} strokeWidth={weight} />
        {red && animated ? <circle cx="24" cy="24" r="22" className="globe-red globe-comet" strokeWidth={weight * 2} /> : null}
      </g>;
    })}
  </svg>;
}
