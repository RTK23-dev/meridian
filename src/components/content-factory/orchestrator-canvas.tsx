import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeEvent, NodeState, OrchestratorPlan } from "@/engine/orchestrator/contracts";
import { NODE_HEIGHT, NODE_WIDTH, layoutPlan } from "@/engine/orchestrator/layout";
import { replayAt } from "@/engine/orchestrator/replay";
import { topologicalOrder } from "@/engine/orchestrator/validate";
import { cn } from "@/lib/cn";
import { CanvasToolbar, NodeCard, Port, StateLegend } from "./orchestrator-canvas-parts";
import { ACCENT, KIND_STYLE, STATE_STYLE, costText, edgeAccent, fitScale, nextZoom, replayStatus, undrawnReason } from "./orchestrator-presentation";

/** Room above the plan for the floating toolbar, so the toolbar never covers a step. */
const TOOLBAR_CLEARANCE = "pt-14";

/**
 * The orchestrator's plan drawn as a flow. It starts as a plain canvas. `shown` is how many events of the run have arrived: each step
 * pops in at its first event, and the line into it draws itself. `stale` marks the steps an edit would run again: they are drawn dashed
 * and labelled, whatever state their last run had. Pure drawing from the plan and the events; nothing here calls a model.
 *
 * The canvas fits its width by default. The toolbar zooms it in steps, and "fit to width" returns to the fitted scale. Every step is a
 * focusable card, in reading order, named by its kind, title and state.
 */
export function OrchestratorCanvas({
  plan,
  events,
  shown,
  stale,
  showAll = false,
}: {
  plan: OrchestratorPlan | null;
  events: NodeEvent[];
  shown: number;
  stale?: ReadonlySet<string>;
  /** Draw every step and line, whether or not the replay has reached it: used while a plan is being edited. */
  showAll?: boolean;
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
  const frame = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
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
      <div className="rounded-xl border border-dashed border-border bg-surface p-6 text-sm text-fg-muted" role="status">
        No plan yet. The orchestrator draws its steps here as it plans them.
      </div>
    );
  }
  // A plan that has steps but no order cannot be drawn. That is an error about the plan, not an empty canvas.
  if (drawn === null) {
    return (
      <div className="rounded-xl border border-danger bg-danger-soft p-6 text-sm text-danger" role="alert">
        The plan cannot be drawn. {undrawnReason(plan.nodes)}
      </div>
    );
  }

  const fitted = fitScale(available, drawn.width);
  const scale = zoom ?? fitted;
  const visible = new Set(plan.nodes.filter((node) => showAll || replay.has(node.id)).map((node) => node.id));
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const kindOf = new Map(drawn.nodes.map((placed) => [placed.id, placed.kind]));
  const feeds = new Set(plan.nodes.flatMap((node) => node.dependsOn));
  // Reading order: column by column, top to bottom, which is the order a person reads the flow in.
  const reading = [...drawn.nodes].sort((a, b) => a.column - b.column || a.y - b.y);

  return (
    <section aria-label="Orchestrator plan" className="relative overflow-hidden rounded-xl border border-border bg-surface">
      <div className="absolute left-3 top-3 z-10">
        <CanvasToolbar
          scale={scale}
          fitted={zoom === null}
          status={replayStatus(shown, events.length, showAll)}
          onZoom={(direction) => setZoom(nextZoom(scale, direction))}
          onFit={() => setZoom(null)}
        />
      </div>

      <div ref={frame} className={cn("max-h-[70vh] overflow-auto bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:20px_20px]", TOOLBAR_CLEARANCE)}>
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
              const node = byId.get(placed.id);
              const isStale = stale?.has(placed.id) ?? false;
              if (!node || !(visible.has(node.id) || isStale)) return null;
              const step = replay.get(node.id);
              const state: NodeState = step?.state ?? "planned";
              const reason = !isStale && STATE_STYLE[state].showsReason ? (step?.reason ?? null) : null;
              return (
                <div key={node.id} className="orch-node absolute" style={{ left: placed.x, top: placed.y, width: NODE_WIDTH, height: NODE_HEIGHT }}>
                  <NodeCard
                    kind={node.kind}
                    title={node.title}
                    model={node.model?.id ?? null}
                    state={state}
                    stale={isStale}
                    cost={costText(step?.costUsd, node.estimateUsd)}
                    reason={reason}
                  />
                  {node.dependsOn.length > 0 ? <Port side="in" accent="muted" /> : null}
                  {feeds.has(node.id) ? <Port side="out" accent={KIND_STYLE[node.kind].accent} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <StateLegend />
    </section>
  );
}
