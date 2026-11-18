import { dotText } from "./canvas-model";

/**
 * Text in the canvas's dot face: each lit dot is a small round dot, as in the owner's reference wordmark. It is an image with the text as
 * its name, so a screen reader reads the word, not the dots. `accent` lights the last dot in vermilion (the meridian's one red point);
 * `fluid` scales the word to the width of its column.
 */
export function DotMatrix({ text, dot = 3, gap = 1.5, label, accent = false, fluid = false, className }: { text: string; dot?: number; gap?: number; label?: string; accent?: boolean; fluid?: boolean; className?: string }) {
  const { width, height, dots } = dotText(text);
  const step = dot + gap;
  const last = dots.length - 1;
  return (
    // A fluid wordmark fills its column's width and keeps its shape; otherwise each dot is drawn at its own size.
    <svg viewBox={`0 0 ${Math.max(1, width * step - gap)} ${height * step - gap}`} width={fluid ? "100%" : Math.max(1, width * step - gap)} height={fluid ? undefined : height * step - gap} role="img" aria-label={label ?? text} className={className}>
      {dots.map(([x, y], index) => (
        <circle key={`${x}-${y}`} cx={x * step + dot / 2} cy={y * step + dot / 2} r={dot / 2} fill={accent && index === last ? "var(--kc-vermilion)" : "currentColor"} />
      ))}
    </svg>
  );
}
