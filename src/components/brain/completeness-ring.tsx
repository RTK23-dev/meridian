/**
 * The required fields with content, as a count. The ring is drawn from the same count, and the count is printed, so the
 * state is not shown by colour or by a rounded percentage that could hide a gap.
 */
export function CompletenessRing({ filled, total }: { filled: number; total: number }) {
  const ratio = total === 0 ? 0 : Math.min(1, Math.max(0, filled / total));
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  return <div role="img" aria-label={`${filled} of ${total} required fields have content.`} className="relative grid size-16 shrink-0 place-items-center">
    <svg viewBox="0 0 64 64" aria-hidden="true" className="absolute inset-0 size-16 -rotate-90">
      <circle cx="32" cy="32" r={radius} fill="none" strokeWidth="8" className="stroke-border" />
      <circle
        cx="32"
        cy="32"
        r={radius}
        fill="none"
        strokeWidth="8"
        strokeLinecap="round"
        className="stroke-accent transition-[stroke-dashoffset] duration-200 motion-reduce:transition-none"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
      />
    </svg>
    <span aria-hidden="true" className="relative text-sm font-semibold tabular-nums">{filled}/{total}</span>
  </div>;
}
