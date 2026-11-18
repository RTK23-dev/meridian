import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Clapperboard, Crosshair, FileText, Folder, Layers, LayoutGrid, Maximize, Minus, Plus } from "lucide-react";
import { ErrorNotice, errorText } from "@/components/ui";
import { GlobeSvg } from "@/components/ui/globe";
import { cn } from "@/components/ui/cn";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { decideVideoCheckpoint, reopenVideoPhase, updateVideoProject, type CanvasProject } from "@/lib/meridian/mcp/project-actions";
import { MODE_COPY, type Phase, type ProjectMode } from "@/lib/meridian/mcp/workflow";
import { qk } from "@/lib/query/keys";
import { useScopedMutation, useVideoProjectQuery, useVideoProjectsQuery } from "@/lib/query/hooks";
import { useMediaQuery } from "@/lib/use-media-query";
import { BOARD_H, BOARD_W, boardWires, CARD_W, canvasFigures, canvasNodes, fitZoom, NODE_STATE_WORDS, slotPosition, stepZoom, type CanvasNode } from "./canvas-model";
import { BriefCard, DeciderPuck, FilesCard, StepCard } from "./canvas-cards";
import { BriefDrawer, FilesDrawer, ProjectsDrawer, StepDrawer } from "./canvas-drawers";
import { CanvasSide } from "./canvas-side";

const EMPTY = { mode: "orchestrator" as const, status: "active" as const, checkpoints: {} };
/** On a phone a card takes the width and the height its words need. */
const LIST_CARD = { position: "relative", width: "100%", height: "auto", minHeight: 168 } as const;
const RAIL_BUTTON = "grid size-10 place-items-center rounded-[12px] text-current hover:bg-black/10 aria-[current=true]:bg-black/15";

type Panel = "projects" | "files" | "brief" | null;

/**
 * The video canvas: one video project as a board of connected cards, in the owner's Katana reference. The brief, the seven steps and the
 * files run as a snake of cards joined by dashed wires; the step being made has a live wire; settled steps carry the puck of who settled
 * them. In Orchestrator mode the chat settles every step and the canvas follows it; in Studio mode the chat offers options and the person
 * settles each step here. The right column counts progress, the mode, the choices waiting and the files, and its hero card names the next
 * move. On a phone the canvas becomes the list: the same cards in the same order.
 */
export function VideoCanvas({ projectId, onProject }: { projectId: string | null; onProject: (id: string | null) => void }) {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const canEdit = hasRole(workspace?.active?.role ?? "viewer", "member");
  const wide = useMediaQuery("(min-width: 64rem)");
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const projects = useVideoProjectsQuery(organizationId);
  const query = useVideoProjectQuery(organizationId, projectId);
  const project: CanvasProject | null = projectId ? query.data ?? null : null;

  // With no video named in the address, the newest one opens, so the canvas is never empty while there is a video to show.
  useEffect(() => {
    if (!projectId && projects.data && projects.data.length > 0) onProject(projects.data[0]!.id);
    // onProject changes identity on every render of the route; the newest id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projects.data]);

  const nodes = useMemo<CanvasNode[]>(() => (project ? canvasNodes(project) : canvasNodes(EMPTY).map((node) => ({ ...node, state: "later" as const }))), [project]);
  const figures = useMemo(() => canvasFigures(project ? nodes : []), [project, nodes]);
  const wires = useMemo(() => boardWires(project ? nodes : null), [project, nodes]);

  const [openStep, setOpenStep] = useState<Phase | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const openNode = nodes.find((node) => node.phase === openStep) ?? null;

  // The zoom fits the board to the frame until the person zooms; Fit returns to it.
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const scale = zoom ?? fit;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !wide) return;
    const measure = () => setFit(fitZoom(stage.clientWidth - 24));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [wide]);

  function follow() {
    const target = figures.current ?? nodes.find((node) => node.state === "settled") ?? null;
    if (!target) return;
    if (!wide) {
      document.getElementById(`kc-step-${target.phase}`)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      return;
    }
    const position = slotPosition(target.phase);
    const scroller = scrollRef.current;
    scroller?.scrollTo({ left: Math.max(0, (position.x + CARD_W / 2) * scale - scroller.clientWidth / 2), top: Math.max(0, position.y * scale - 80), behavior: reduceMotion ? "auto" : "smooth" });
  }

  const invalidate = () => [qk.videoProject(organizationId, projectId ?? ""), qk.videoProjects(organizationId)];
  const decide = useScopedMutation<{ phase: Phase; choice: string | null; input: string | null }, CanvasProject>({
    mutationKey: ["mutation", "video-project.decide", organizationId, projectId ?? ""],
    mutationFn: (vars) => decideVideoCheckpoint({ data: { organizationId, projectId: projectId ?? "", ...vars } }),
    invalidate,
    success: (vars) => `Settled. The chat builds the next step on your ${vars.input ? "words" : "choice"}.`,
  });
  const reopen = useScopedMutation<Phase, CanvasProject>({
    mutationKey: ["mutation", "video-project.reopen", organizationId, projectId ?? ""],
    mutationFn: (phase) => reopenVideoPhase({ data: { organizationId, projectId: projectId ?? "", phase } }),
    invalidate,
    success: "Reopened. The chat makes this step again.",
  });
  const update = useScopedMutation<{ mode?: ProjectMode; abandon?: boolean }, CanvasProject>({
    mutationKey: ["mutation", "video-project.update", organizationId, projectId ?? ""],
    mutationFn: (vars) => updateVideoProject({ data: { organizationId, projectId: projectId ?? "", ...vars } }),
    invalidate,
    success: (vars) => (vars.abandon ? "The video is stopped." : `Now in ${MODE_COPY[vars.mode ?? "studio"].label} mode.`),
  });

  const status = project
    ? figures.current
      ? `${project.title}: ${figures.current.label}, ${NODE_STATE_WORDS[figures.current.state].toLowerCase()}.`
      : project.status === "abandoned" ? `${project.title} is stopped.` : `${project.title}: every step is settled.`
    : "No video is open.";

  const error = projects.isError ? projects.error : query.isError ? query.error : null;

  const boardCards = (list: boolean) => (
    <>
      <BriefCard brief={project?.brief ?? null} onOpen={() => setPanel("brief")} style={list ? LIST_CARD : { left: slotPosition("brief").x, top: slotPosition("brief").y }} />
      {nodes.map((node) => (
        <StepCard
          key={node.phase}
          node={node}
          files={project?.files ?? []}
          empty={!project}
          onOpen={() => setOpenStep(node.phase)}
          style={list ? LIST_CARD : { left: slotPosition(node.phase).x, top: slotPosition(node.phase).y }}
        />
      ))}
      <FilesCard files={project?.files ?? []} onOpen={() => setPanel("files")} style={list ? LIST_CARD : { left: slotPosition("files").x, top: slotPosition("files").y }} />
    </>
  );

  const topBar = (
    <div className={cn("flex flex-wrap items-start justify-between gap-2", wide ? "pointer-events-none absolute inset-x-4 top-4 z-10" : "mb-4")}>
      <button type="button" onClick={() => setPanel("projects")} className="kc-tile kc-chip pointer-events-auto flex min-h-11 max-w-[min(22rem,100%)] items-center gap-2 py-1.5 pl-1.5 pr-4 text-left">
        <span className="kc-pill grid size-8 shrink-0 place-items-center rounded-full"><Clapperboard aria-hidden="true" className="size-4" /></span>
        <span className="min-w-0">
          <span className="block text-caption font-semibold">Video project</span>
          <span className="kc-tile-muted block truncate text-caption">{project?.title ?? (projects.data?.length === 0 ? "No video yet" : "Choose a video")}</span>
        </span>
      </button>
      <div className="kc-pill pointer-events-auto flex min-h-11 items-center gap-3 py-1.5 pl-2 pr-1.5">
        <span className="flex -space-x-2" aria-hidden="true">
          <DeciderPuck who="person" settled={false} />
          <DeciderPuck who="chat" settled={false} />
          <DeciderPuck who="decision_engine" settled={false} />
        </span>
        <span className="text-caption">
          <span className="block font-semibold">{project ? MODE_COPY[project.mode].label : "Who decides"}</span>
          <span className="block opacity-80">{project ? (project.mode === "orchestrator" ? "The chat decides" : project.mode === "guided" ? "You: script, final cut" : "You choose each step") : "You, the chat, Meridian"}</span>
        </span>
        <Link to="/create" search={{ way: "claude_code" }} aria-label="Make a new video" title="Make a new video" className="kc-plus size-8"><Plus aria-hidden="true" className="size-4" /></Link>
      </div>
    </div>
  );

  return (
    <section className="kc" aria-label="Video canvas">
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
      <div className="kc-frame">
        {wide ? (
          <nav className="kc-rail" aria-label="Canvas">
            <span className="kc-pill mb-2 grid size-10 place-items-center rounded-full" aria-hidden="true"><GlobeSvg size={22} /></span>
            <button type="button" aria-current="true" aria-label="Canvas" title="Canvas" className={RAIL_BUTTON}><Layers aria-hidden="true" className="size-5" /></button>
            <button type="button" onClick={() => setPanel("projects")} aria-label="Videos" title="Videos" className={RAIL_BUTTON}><LayoutGrid aria-hidden="true" className="size-5" /></button>
            <button type="button" onClick={() => setPanel("files")} aria-label="Files" title="Files" className={RAIL_BUTTON}><Folder aria-hidden="true" className="size-5" /></button>
            <button type="button" onClick={() => setPanel("brief")} aria-label="Brief" title="Brief" className={RAIL_BUTTON}><FileText aria-hidden="true" className="size-5" /></button>
            <span className="kc-rail-gap" />
            <Link to="/create" search={{ way: "claude_code" }} aria-label="Make a new video" title="Make a new video" className="kc-plus size-10"><Plus aria-hidden="true" className="size-5" /></Link>
          </nav>
        ) : null}

        <div ref={stageRef} className="kc-stage">
          {/* The page title is the h1; the steps and the side column are its sections, so each card's h3 sits under an h2. */}
          <h2 className="sr-only">The steps of the video</h2>
          {error ? <div className="absolute inset-x-4 top-20 z-20"><ErrorNotice>{errorText(error)}</ErrorNotice></div> : null}
          {topBar}
          {wide ? (
            <>
              <div ref={scrollRef} className="kc-scroll" tabIndex={0} role="region" aria-label="The steps of the video. Scroll to move around the board.">
                <div className="mx-auto" style={{ width: Math.max(BOARD_W * scale, 1), height: BOARD_H * scale + 160, paddingTop: 72 }}>
                  <div className="kc-board" style={{ width: BOARD_W, height: BOARD_H, transform: `scale(${scale})` }}>
                    <svg aria-hidden="true" className="absolute inset-0" width={BOARD_W} height={BOARD_H} viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}>
                      {wires.map((wire) => (
                        <g key={`${wire.from}-${wire.to}`}>
                          <path d={wire.d} className={cn("kc-wire", wire.state === "done" && "kc-wire-done", wire.state === "live" && "kc-wire-live")} />
                          <circle cx={wire.start[0]} cy={wire.start[1]} r={3.5} className="kc-wire-end" />
                          <circle cx={wire.end[0]} cy={wire.end[1]} r={3.5} className="kc-wire-end" />
                        </g>
                      ))}
                    </svg>
                    {boardCards(false)}
                  </div>
                </div>
              </div>
              <div className="kc-pill absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 p-1.5" role="toolbar" aria-label="Board">
                <button type="button" onClick={() => setZoom(stepZoom(scale, -1))} disabled={scale <= 0.5} aria-label="Zoom out" title="Zoom out" className="grid size-9 place-items-center rounded-[10px] hover:bg-white/10 disabled:opacity-40"><Minus aria-hidden="true" className="size-4" /></button>
                <span className="w-12 text-center font-mono text-caption" aria-label={`Zoom ${Math.round(scale * 100)} percent`}>{Math.round(scale * 100)}%</span>
                <button type="button" onClick={() => setZoom(stepZoom(scale, 1))} disabled={scale >= 1} aria-label="Zoom in" title="Zoom in" className="grid size-9 place-items-center rounded-[10px] hover:bg-white/10 disabled:opacity-40"><Plus aria-hidden="true" className="size-4" /></button>
                <button type="button" onClick={() => setZoom(null)} aria-pressed={zoom === null} aria-label="Fit the board" title="Fit the board" className="grid size-9 place-items-center rounded-[10px] hover:bg-white/10 aria-pressed:bg-white/15"><Maximize aria-hidden="true" className="size-4" /></button>
                <button type="button" onClick={follow} aria-label="Go to the step being made" title="Go to the step being made" className="grid size-9 place-items-center rounded-[10px] hover:bg-white/10"><Crosshair aria-hidden="true" className="size-4" /></button>
                <Link to="/create" search={{ way: "claude_code" }} aria-label="Make a new video" title="Make a new video" className="kc-plus ml-1 size-9"><Plus aria-hidden="true" className="size-4" /></Link>
              </div>
            </>
          ) : (
            <div className="relative flex flex-col gap-6">
              <span aria-hidden="true" className="absolute bottom-6 left-1/2 top-6 border-l border-dashed border-[var(--kc-wire)]" />
              {boardCards(true)}
            </div>
          )}
        </div>

        <CanvasSide
          project={project}
          figures={figures}
          canEdit={canEdit}
          modeBusy={update.isPending}
          onMode={(mode) => update.mutate({ mode })}
          onFollow={follow}
          onChoose={() => { if (figures.current) setOpenStep(figures.current.phase); }}
          onFiles={() => setPanel("files")}
          onBrief={() => setPanel("brief")}
        />
      </div>

      <StepDrawer
        open={openStep !== null}
        onOpenChange={(open) => { if (!open) setOpenStep(null); }}
        project={project}
        node={openNode}
        canEdit={canEdit && !!project}
        busy={decide.isPending || reopen.isPending}
        onDecide={(phase, answer) => decide.mutateAsync({ phase, ...answer })}
        onReopen={(phase) => reopen.mutateAsync(phase)}
      />
      <ProjectsDrawer
        open={panel === "projects"}
        onOpenChange={(open) => setPanel(open ? "projects" : null)}
        projects={projects.data}
        currentId={projectId}
        onPick={(id) => { onProject(id); setPanel(null); }}
        canEdit={canEdit}
        current={project}
        busy={update.isPending}
        onStop={() => update.mutateAsync({ abandon: true })}
      />
      <FilesDrawer open={panel === "files"} onOpenChange={(open) => setPanel(open ? "files" : null)} files={project?.files ?? []} />
      <BriefDrawer open={panel === "brief"} onOpenChange={(open) => setPanel(open ? "brief" : null)} project={project} />
    </section>
  );
}
