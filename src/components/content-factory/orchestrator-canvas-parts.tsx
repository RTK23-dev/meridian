import { AudioLines, FileText, Film, Image as ImageIcon, LayoutGrid, Maximize2, Paperclip, ScanSearch, Scissors, UserRound, Video, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
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

/** A state is a dot and a word. Colour is never the only signal, and no state is filled with a tint. A running step's dot is not animated: the
 *  running state is shown by its colour and its word, and the reduced-motion rule never needs to stop anything here. */
export function StatePill({ label, accent }: { label: string; accent: Accent }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium", ACCENT[accent].text)}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", ACCENT[accent].dot)} />
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
        "absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full border-2 border-raised",
        side === "in" ? "-left-[6px] bg-raised border-border-strong" : cn("-right-[6px]", ACCENT[accent].dot),
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
  /** The step whose details are open. */
  selected?: boolean;
  /** Choosing the step. When given, the card can be chosen with a pointer, Enter or Space. */
  onSelect?: () => void;
};

/** One step as a card: kind icon and label, state, title, the live model id, the cost, and the reason when it stopped. */
export function NodeCard({ kind, title, model, state, stale, cost, reason, selected = false, onSelect }: NodeCardProps) {
  const look: StateStyle = stale ? STALE_STYLE : STATE_STYLE[state];
  const kindStyle = KIND_STYLE[kind];
  const press = (event: KeyboardEvent<HTMLElement>) => {
    if (!onSelect) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };
  return (
    <article
      tabIndex={0}
      role={onSelect ? "button" : undefined}
      aria-pressed={onSelect ? selected : undefined}
      aria-label={stepName({ kind, title, state, stale, model, cost })}
      data-state={state}
      data-stale={stale ? "true" : undefined}
      onClick={onSelect}
      onKeyDown={press}
      className={cn(
        "flex h-full w-full flex-col gap-1 rounded-sharp bg-raised p-3",
        onSelect && "cursor-pointer hover:border-fg-secondary",
        stale ? "border-2 border-dashed border-warning" : look.pulse ? "border border-info" : "border border-hairline",
        selected && "border-fg-primary",
      )}
    >
      <header className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-sharp border border-hairline text-fg-secondary">
          <KindIcon kind={kind} className="size-3.5" />
        </span>
        <span className="min-w-0 truncate text-[11px] font-medium text-fg-muted">{kindStyle.label}</span>
        <span className="ml-auto shrink-0">
          <StatePill label={look.label} accent={look.accent} />
        </span>
      </header>
      <p className="truncate text-sm font-medium text-fg-primary" title={title}>
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
    <div role="toolbar" aria-label="Canvas controls" className="flex items-center gap-1 rounded-sharp border border-hairline bg-raised p-1">
      <Button type="button" variant="ghost" size="sm" className="px-2" aria-label="Zoom out" title="Zoom out" disabled={scale <= ZOOM_MIN} onClick={() => onZoom("out")}>
        <ZoomOut aria-hidden="true" className="size-4" />
      </Button>
      <span className="w-11 text-center text-xs tabular-nums text-fg-primary" aria-live="polite">
        {Math.round(scale * 100)}%
      </span>
      <Button type="button" variant="ghost" size="sm" className="px-2" aria-label="Zoom in" title="Zoom in" disabled={scale >= ZOOM_MAX} onClick={() => onZoom("in")}>
        <ZoomIn aria-hidden="true" className="size-4" />
      </Button>
      <Button type="button" variant="ghost" size="sm" className="px-2" aria-label="Fit to width" title="Fit to width" aria-pressed={fitted} onClick={onFit}>
        <Maximize2 aria-hidden="true" className="size-4" />
      </Button>
      <span aria-hidden="true" className="mx-1 hidden h-4 w-px bg-hairline sm:block" />
      <span className="hidden whitespace-nowrap px-2 text-xs text-fg-muted sm:block">{status}</span>
    </div>
  );
}

/** The state of every step as a key: each colour and word the canvas can show, and the dashed "To re-run" mark. */
export function StateLegend() {
  const items = [...(Object.keys(STATE_STYLE) as NodeState[]).map((state) => STATE_STYLE[state]), STALE_STYLE];
  return (
    <ul aria-label="State legend" className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-hairline px-3 py-2 text-xs text-fg-muted">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-2 rounded-full", ACCENT[item.accent].dot)} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
