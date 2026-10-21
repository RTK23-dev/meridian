import { AudioLines, FileText, Film, Image as ImageIcon, LayoutGrid, Maximize2, Paperclip, ScanSearch, Scissors, UserRound, Video, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui";
import type { NodeKind, NodeState } from "@/engine/orchestrator/contracts";
import { cn } from "@/lib/cn";
import {
  ACCENT,
  KIND_STYLE,
  STALE_STYLE,
  STATE_STYLE,
  ZOOM_MAX,
  ZOOM_MIN,
  stepName,
  type Accent,
  type KindIconName,
  type StateStyle,
} from "./orchestrator-presentation";

/** The icon component of each icon name. Which name a step kind wears is set in KIND_STYLE (orchestrator-presentation.ts). */
const ICONS: Record<KindIconName, LucideIcon> = {
  source: Paperclip,
  scan: ScanSearch,
  text: FileText,
  image: ImageIcon,
  video: Video,
  audio: AudioLines,
  person: UserRound,
  cut: Scissors,
  layout: LayoutGrid,
  film: Film,
};

export function KindIcon({ kind, className }: { kind: NodeKind; className?: string }) {
  const Icon = ICONS[KIND_STYLE[kind].icon];
  return <Icon aria-hidden="true" className={className} />;
}

export function StatePill({ label, accent, pulse }: { label: string; accent: Accent; pulse: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", ACCENT[accent].soft, ACCENT[accent].text)}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", ACCENT[accent].dot, pulse && "motion-safe:animate-pulse")} />
      {label}
    </span>
  );
}

/** A connection point on a card's edge. An input is a ring; an output is filled in the colour of the kind it carries. */
export function Port({ side, accent }: { side: "in" | "out"; accent: Accent }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full border-2 border-surface",
        side === "in" ? "-left-[6px] bg-surface ring-1 ring-border-strong" : cn("-right-[6px]", ACCENT[accent].dot),
      )}
    />
  );
}

export type NodeCardProps = {
  kind: NodeKind;
  title: string;
  model: string | null;
  state: NodeState;
  stale: boolean;
  cost: string | null;
  reason: string | null;
};

/** One step as a card: kind icon and label, state, title, the live model id, the cost, and the reason when it stopped. */
export function NodeCard({ kind, title, model, state, stale, cost, reason }: NodeCardProps) {
  const look: StateStyle = stale ? STALE_STYLE : STATE_STYLE[state];
  const kindStyle = KIND_STYLE[kind];
  const kindTone = ACCENT[kindStyle.accent];
  return (
    <article
      tabIndex={0}
      aria-label={stepName({ kind, title, state, stale, model, cost })}
      data-state={state}
      data-stale={stale ? "true" : undefined}
      className={cn(
        "flex h-full w-full flex-col gap-1 rounded-xl bg-surface p-3 shadow-sm",
        stale ? "border-2 border-dashed border-warning" : look.pulse ? "border border-info" : "border border-border",
      )}
    >
      <header className="flex items-center gap-2">
        <span className={cn("grid size-6 shrink-0 place-items-center rounded-md", kindTone.soft, kindTone.text)}>
          <KindIcon kind={kind} className="size-3.5" />
        </span>
        <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wider text-fg-muted">{kindStyle.label}</span>
        <span className="ml-auto shrink-0">
          <StatePill label={look.label} accent={look.accent} pulse={look.pulse} />
        </span>
      </header>
      <p className="truncate text-sm font-medium text-fg" title={title}>
        {title}
      </p>
      <p className="truncate font-mono text-[11px] text-fg-muted" title={model ?? undefined}>
        {model ?? "No model call"}
      </p>
      <footer className="mt-auto flex items-center justify-between gap-2 text-xs">
        <span className="truncate tabular-nums text-fg-muted">{cost ?? ""}</span>
      </footer>
      {reason !== null ? (
        <p className={cn("truncate text-[11px]", ACCENT[look.accent].text)} title={reason}>
          {reason}
        </p>
      ) : null}
    </article>
  );
}

/** The floating controls at the top of a canvas: zoom out, the zoom level, zoom in, fit to width, and the replay position. */
export function CanvasToolbar({
  scale,
  fitted,
  status,
  onZoom,
  onFit,
}: {
  scale: number;
  fitted: boolean;
  status: string;
  onZoom: (direction: "in" | "out") => void;
  onFit: () => void;
}) {
  return (
    <div role="toolbar" aria-label="Canvas controls" className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1 shadow-md">
      <Button type="button" variant="ghost" size="sm" className="px-2" aria-label="Zoom out" title="Zoom out" disabled={scale <= ZOOM_MIN} onClick={() => onZoom("out")}>
        <ZoomOut aria-hidden="true" className="size-4" />
      </Button>
      <span className="w-11 text-center text-xs tabular-nums text-fg" aria-live="polite">
        {Math.round(scale * 100)}%
      </span>
      <Button type="button" variant="ghost" size="sm" className="px-2" aria-label="Zoom in" title="Zoom in" disabled={scale >= ZOOM_MAX} onClick={() => onZoom("in")}>
        <ZoomIn aria-hidden="true" className="size-4" />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="px-2" aria-label="Fit to width" title="Fit to width" aria-pressed={fitted} onClick={onFit}>
        <Maximize2 aria-hidden="true" className="size-4" />
      </Button>
      <span aria-hidden="true" className="mx-1 hidden h-4 w-px bg-border sm:block" />
      <span className="hidden whitespace-nowrap px-2 text-xs text-fg-muted sm:block">{status}</span>
    </div>
  );
}

/** The state of every step as a key: each colour and word the canvas can show, and the dashed "To re-run" mark. */
export function StateLegend() {
  const items = [...(Object.keys(STATE_STYLE) as NodeState[]).map((state) => STATE_STYLE[state]), STALE_STYLE];
  return (
    <ul aria-label="State legend" className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border px-3 py-2 text-xs text-fg-muted">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-2 rounded-full", ACCENT[item.accent].dot)} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
