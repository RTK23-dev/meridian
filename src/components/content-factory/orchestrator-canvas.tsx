import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeEvent, NodeState, OrchestratorPlan } from "@/engine/orchestrator/contracts";
import { NODE_HEIGHT, NODE_WIDTH, layoutPlan } from "@/engine/orchestrator/layout";
import { replayAt } from "@/engine/orchestrator/replay";
import { topologicalOrder } from "@/engine/orchestrator/validate";
import { cn } from "@/lib/cn";
import { CanvasToolbar, NodeCard, Port, StateLegend } from "./orchestrator-canvas-parts";
import {
  ACCENT,
  DEFAULT_ZOOM,
  KIND_STYLE,
  PHONE_LIST_BELOW_PX,
  STATE_STYLE,
  costText,
  edgeAccent,
  fitScale,
  nextZoom,
  readingOrder,
  replayStatus,
  undrawnReason,
} from "./orchestrator-presentation";

/** Room above the plan for the floating toolbar, so the toolbar never covers a step. */
const TOOLBAR_CLEARANCE = "pt-14";

/**
 * The orchestrator's plan drawn as a flow. It opens at 75 percent. `shown` is how many events of the run have arrived: each step appears at
 * its first event, and the line into it draws itself. `stale` marks the steps an edit would run again: they are drawn dashed and labelled,
 * whatever state their last run had. A step is chosen by a pointer, Enter or Space; the chosen step is the one whose details are open. On a
 * phone (a narrow width) the plan is its list of steps, in reading order, and there is no canvas to pan. Pure drawing from the plan and the
 * events; nothing here calls a model.
 */
export function OrchestratorCanvas({
  plan,
  events,
  shown,
  stale,
  showAll = false,
  selectedId = null,
  onSelect,
}: {
  plan: OrchestratorPlan | null;
  events: NodeEvent[];
  shown: number;
  stale?: ReadonlySet<string>;
  /** Draw every step and line, whether or not the replay has reached it: used while a plan is being edited. */
  showAll?: boolean;
  /** The step whose details are open, if any. */
  selectedId?: string | null;
  /** Choosing a step opens its details. Without it, the cards are not buttons. */
  onSelect?: (id: string) => void;
}) {
  const drawn = useMemo(() => {
    if (plan === null) return null;
    const order = topologicalOrder(plan.nodes);
    if (order === null) return null;
    return layoutPlan(plan, order);
  }, [plan]);

  const replay = useMemo(() => replayAt(events, shown), [events, shown]);

  // The width the canvas may use is measured again whenever a plan appears, so a canvas that mounts empty still fits once it has a plan.
  const hasPlan = drawn !== null;
  const frame = useRef<HTMLElement>(null);
  const [available, setAvailable] = useState(0);
  const [zoom, setZoom] = useState<number | null>(DEFAULT_ZOOM);
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    setAvailable(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setAvailable(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasPlan]);

  if (plan === null) {
    return (
      <div className="rounded-sharp border border-dashed border-border-strong bg-raised p-6 text-sm text-fg-muted" role="status">
        No plan yet. The orchestrator draws its steps here as it plans them.
      </div>
    );
  }
  // A plan that has steps but no order cannot be drawn. That is an error about the plan, not an empty canvas.
  if (drawn === null) {
    return (
      <div className="rounded-sharp border border-danger bg-raised p-6 text-sm text-danger" role="alert">
        The plan cannot be drawn. {undrawnReason(plan.nodes)}
      </div>
    );
  }

  const compact = available > 0 && available < PHONE_LIST_BELOW_PX;
  const fitted = fitScale(available, drawn.width);
  const scale = zoom ?? fitted;
  const visible = new Set(plan.nodes.filter((node) => showAll || replay.has(node.id)).map((node) => node.id));
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const kindOf = new Map(drawn.nodes.map((placed) => [placed.id, placed.kind]));
  const feeds = new Set(plan.nodes.flatMap((node) => node.dependsOn));
  const reading = readingOrder(drawn.nodes);
  const cardFor = (placed: (typeof reading)[number]) => {
    const node = byId.get(placed.id);
    if (!node) return null;
    const isStale = stale?.has(placed.id) ?? false;
    const step = replay.get(node.id);
    const state: NodeState = step?.state ?? "planned";
    const reason = !isStale && STATE_STYLE[state].showsReason ? (step?.reason ?? null) : null;
    return { node, isStale, card: { kind: node.kind, title: node.title, model: node.model?.id ?? null, state, stale: isStale, cost: costText(step?.costUsd, node.estimateUsd), reason } };
  };
  const choose = onSelect ? (id: string) => onSelect(id) : undefined;

  return (
    <section ref={frame} aria-label="Orchestrator plan" className="relative overflow-hidden rounded-sharp border border-hairline bg-ground">
      {compact ? (
        <ol aria-label="Plan steps in reading order" className="grid gap-3 p-3">
          {reading.map((placed) => {
            const entry = cardFor(placed);
            if (!entry || !(visible.has(entry.node.id) || entry.isStale)) return null;
            return (
              <li key={entry.node.id} className="min-w-0">
                <NodeCard {...entry.card} selected={selectedId === entry.node.id} onSelect={choose ? () => choose(entry.node.id) : undefined} />
              </li>
            );
          })}
        </ol>
      ) : (
        <>
          <div className="absolute left-3 top-3 z-10">
            <CanvasToolbar
              scale={scale}
              fitted={zoom === null}
              status={replayStatus(shown, events.length, showAll)}
              onZoom={(direction) => setZoom(nextZoom(scale, direction))}
              onFit={() => setZoom(null)}
            />
          </div>

          <div role="region" aria-label="Plan canvas" tabIndex={0} className={cn("max-h-[70vh] overflow-auto bg-[radial-gradient(var(--border-hairline)_1px,transparent_1px)] [background-size:20px_20px] focus-visible:outline-2 focus-visible:outline-accent", TOOLBAR_CLEARANCE)}>
            <div className="relative" style={{ width: drawn.width * scale, height: drawn.height * scale }}>
              <div className="absolute left-0 top-0 origin-top-left" style={{ width: drawn.width, height: drawn.height, transform: `scale(${scale})` }}>
                <svg className="absolute left-0 top-0" width={drawn.width} height={drawn.height} aria-hidden="true">
                  {drawn.edges
                    .filter((edge) => visible.has(edge.to))
                    .map((edge) => {
                      const from = kindOf.get(edge.from);
                      return (
                        <path
                          key={`${edge.from}->${edge.to}`}
                          d={edge.d}
                          pathLength={1}
                          fill="none"
                          strokeWidth={2}
                          strokeLinecap="round"
                          className={cn("orch-edge", ACCENT[from ? edgeAccent(from) : "muted"].stroke)}
                        />
                      );
                    })}
                </svg>

                {reading.map((placed) => {
                  const entry = cardFor(placed);
                  if (!entry || !(visible.has(entry.node.id) || entry.isStale)) return null;
                  const { node, card } = entry;
                  return (
                    <div key={node.id} className="absolute" style={{ left: placed.x, top: placed.y, width: NODE_WIDTH, height: NODE_HEIGHT }}>
                      <NodeCard {...card} selected={selectedId === node.id} onSelect={choose ? () => choose(node.id) : undefined} />
                      {node.dependsOn.length > 0 ? <Port side="in" accent="muted" /> : null}
                      {feeds.has(node.id) ? <Port side="out" accent={KIND_STYLE[node.kind].accent} /> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}

      <StateLegend />
    </section>
  );
}
