import { useEffect, useState } from "react";
import { LINE_ALPHA, RING_ALPHA, markFrame, type LinePaths } from "./globe-motion";

/** The still mark is the slice: the red meridian edge-on, at t = 0 (section g). */
const STILL_TIME = 0;

/** A line drawn in its two halves: the near half at one strength, the half behind the globe at another. */
function Line({ paths, className, width, near, far }: { paths: LinePaths; className: string; width: number; near: number; far: number }) {
  return <>
    {paths.near ? <path d={paths.near} className={className} strokeWidth={width} strokeOpacity={near} /> : null}
    {paths.far ? <path d={paths.far} className={className} strokeWidth={width} strokeOpacity={far} /> : null}
  </>;
}

/**
 * The meridian globe, drawn from one frame of globe-motion.ts. Still, it shows the slice (t = 0). Animated, it runs the 12 s loop at one
 * steady speed, from one clock shared by every mark on the page, and it holds the slice when the page asks for reduced motion.
 */
export function GlobeSvg({ size, animated = false }: { size: number; animated?: boolean }) {
  const [time, setTime] = useState(STILL_TIME);

  useEffect(() => {
    if (!animated || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const tick = () => {
      setTime(performance.now() / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animated]);

  const { latitudes, meridians, ring, comet, head, widths } = markFrame(animated ? time : STILL_TIME, size);
  return <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false" className="shrink-0">
    <circle cx="24" cy="24" r="22" className="globe-ink" strokeWidth={widths.rim} strokeOpacity={LINE_ALPHA.rim} />
    {[...latitudes, ...meridians].map((paths, index) => (
      <Line key={index} paths={paths} className="globe-ink" width={widths.hairline} near={LINE_ALPHA.near} far={LINE_ALPHA.far} />
    ))}
    <Line paths={ring} className="globe-red" width={widths.tail} near={RING_ALPHA} far={LINE_ALPHA.far} />
    {comet.map((segment, index) => (
      <path key={index} d={segment.d} className="globe-red" strokeWidth={segment.width} strokeOpacity={segment.opacity} />
    ))}
    <circle cx={head.x} cy={head.y} r={head.r} className="globe-head" opacity={head.opacity} />
  </svg>;
}
