import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronDown, Info, Link2, Settings } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, toast } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { CanvasProject } from "@/lib/meridian/mcp/project-actions";
import { MODE_COPY, PROJECT_MODES, type ProjectMode } from "@/lib/meridian/mcp/workflow";
import { fileCounts, MODE_LETTER, nextMove, spendLine, type CanvasFigures, type NextMove } from "./canvas-model";
import { DeciderPuck } from "./canvas-cards";
import { DotMatrix } from "./dot-matrix";

const TILE_HEAD = "flex items-center justify-between gap-2 text-small font-semibold";
const ROUND = "kc-chip grid size-8 place-items-center";

/** The progress tile: one bar per step, as the reference's level meter, with the count beneath. */
function ProgressTile({ figures, onFollow }: { figures: CanvasFigures; onFollow: () => void }) {
  return (
    <section aria-labelledby="kc-progress" className="kc-tile flex flex-col gap-2 p-3">
      <div className={TILE_HEAD}>
        <h2 id="kc-progress">Progress</h2>
        <button type="button" onClick={onFollow} aria-label="Go to the step being made" className={ROUND}><ArrowRight aria-hidden="true" className="size-4" /></button>
      </div>
      <div aria-hidden="true" className="flex h-12 items-end justify-center gap-1">
        {figures.bars.map((bar, index) => (
          <span key={index} className={cn("w-1.5 rounded-full", bar === 1 ? "bg-[var(--kc-tile-ink)]" : bar > 0.5 ? "bg-[var(--kc-vermilion)]" : "bg-[var(--kc-tile-muted)]")} style={{ height: `${Math.round(bar * 100)}%` }} />
        ))}
      </div>
      <p className="flex items-baseline justify-between gap-2 text-caption">
        <span className="font-semibold">{figures.settled} of {figures.total} settled</span>
        <span className="kc-tile-muted font-mono">{figures.percent}%</span>
      </p>
    </section>
  );
}

/** The mode tile: the mode's letter in the dot face, and a menu to change how involved the person is. */
function ModeTile({ mode, canEdit, busy, onMode }: { mode: ProjectMode | null; canEdit: boolean; busy: boolean; onMode: (mode: ProjectMode) => void }) {
  return (
    <section aria-labelledby="kc-mode" className="kc-tile flex flex-col gap-2 p-3">
      <div className={TILE_HEAD}>
        <h2 id="kc-mode">Mode</h2>
        {mode ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" disabled={!canEdit || busy} aria-label="Change how involved you are" title={canEdit ? "Change how involved you are" : "Only a member can change the mode"} className={cn(ROUND, "disabled:opacity-50")}>
                <ChevronDown aria-hidden="true" className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-72">
              {PROJECT_MODES.map((item) => (
                <DropdownMenuItem key={item} disabled={item === mode} onSelect={() => onMode(item)}>
                  <span className="flex flex-col gap-1">
                    <span className="font-semibold">{MODE_COPY[item].label}{item === mode ? " (now)" : ""}</span>
                    <span className="text-caption text-fg-muted">{MODE_COPY[item].summary}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className="grid h-12 place-items-center">
        {mode ? <DotMatrix text={MODE_LETTER[mode]} dot={5} gap={1.6} label={MODE_COPY[mode].label} /> : <span className="kc-tile-muted text-caption">No video open</span>}
      </div>
      <p className="text-caption font-semibold">{mode ? MODE_COPY[mode].label : "Mode"}</p>
    </section>
  );
}

/** The right-hand column: four tiles, the dot-matrix hero card with the next move, and three small tools. */
export function CanvasSide({
  project, figures, canEdit, modeBusy, onMode, onFollow, onChoose, onFiles, onBrief,
}: {
  project: CanvasProject | null;
  figures: CanvasFigures;
  canEdit: boolean;
  modeBusy: boolean;
  onMode: (mode: ProjectMode) => void;
  onFollow: () => void;
  onChoose: () => void;
  onFiles: () => void;
  onBrief: () => void;
}) {
  const counts = fileCounts(project?.files ?? []);
  const fileTotal = counts.voiceover + counts.image + counts.video;
  const move: NextMove = project ? nextMove(project, figures) : { label: "Make a video", short: "New video", kind: "new" };
  const waiting = figures.current?.state === "yours" ? figures.current : null;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("The link to this canvas is copied.");
    } catch {
      toast.error("The link could not be copied. Copy it from the address bar.");
    }
  }

  return (
    <aside className="kc-side" aria-label="This video">
      <div className="grid grid-cols-2 gap-3">
        <ProgressTile figures={figures} onFollow={onFollow} />
        <ModeTile mode={project?.mode ?? null} canEdit={canEdit} busy={modeBusy} onMode={onMode} />
        <section aria-labelledby="kc-choices" className="kc-tile flex min-h-28 flex-col gap-2 p-3">
          <div className={TILE_HEAD}>
            <h2 id="kc-choices">Choices</h2>
            {figures.waitingOnYou > 0 ? <span className="kc-badge" aria-label={`${figures.waitingOnYou} waiting for you`}>{figures.waitingOnYou}</span> : null}
          </div>
          {waiting ? (
            <button type="button" onClick={onChoose} className="mt-auto text-left">
              <span className="block font-display text-heading font-semibold">{waiting.label}</span>
              <span className="kc-tile-muted text-caption">{waiting.optionCount} options wait for you</span>
            </button>
          ) : <p className="kc-tile-muted mt-auto text-caption">Nothing waits for you.</p>}
        </section>
        <section aria-labelledby="kc-files-tile" className="kc-tile flex min-h-28 flex-col gap-2 p-3">
          <div className={TILE_HEAD}>
            <h2 id="kc-files-tile">Files</h2>
            {fileTotal > 0 ? <span className="kc-badge" aria-label={`${fileTotal} files`}>{fileTotal}</span> : null}
          </div>
          <button type="button" onClick={onFiles} className="mt-auto flex flex-wrap gap-1 text-left" aria-label={`Open the files: ${counts.voiceover} voice, ${counts.image} images, ${counts.video} video`}>
            {([["mp3", counts.voiceover], ["png", counts.image], ["mp4", counts.video]] as const).map(([chip, count]) => (
              <span key={chip} className={cn("kc-chip px-2 py-1 font-mono text-caption", count > 0 ? "bg-[var(--kc-pill)] text-[var(--kc-pill-ink)]" : "kc-tile-muted border border-current/30")}>{chip} {count}</span>
            ))}
          </button>
        </section>
      </div>

      <section aria-labelledby="kc-hero" className="kc-tile flex flex-1 flex-col gap-3 p-4">
        <h2 id="kc-hero" className="sr-only">{project ? project.title : "No video open"}</h2>
        <DotMatrix text="Meridian" dot={3.2} gap={1.5} label="Meridian" accent fluid />
        <span className="kc-chip w-fit bg-black/10 px-3 py-1 text-caption">{project ? (project.brandName ?? "No brand") : "Video project"}</span>
        <div className="relative grid flex-1 place-items-center py-1">
          <div className="kc-sun grid aspect-square w-[min(136px,62%)] place-items-center text-black">
            <DotMatrix text={`${figures.settled}/${figures.total}`} dot={4} gap={1.6} label={`${figures.settled} of ${figures.total} steps settled`} />
          </div>
          {figures.current?.decides ? <DeciderPuck who={figures.current.decides === "person" ? "person" : "chat"} settled={false} className="absolute bottom-1 right-2" /> : null}
        </div>
        <p className="text-small font-semibold">{project ? (figures.current ? `Now: ${figures.current.label}` : project.status === "abandoned" ? "Stopped" : "Every step is settled") : "No video yet"}</p>
        <div className="flex items-end justify-between gap-2">
          <p className="min-w-0 text-caption">
            <span className="block font-semibold">Spent</span>
            <span className="kc-tile-muted whitespace-nowrap font-mono">{project ? spendLine(project) : "$0.00"}</span>
          </p>
          {move.kind === "new" ? (
            <Link to="/create" search={{ way: "claude_code" }} aria-label={move.label} className="kc-pill inline-flex min-h-9 shrink-0 items-center gap-2 px-3 text-caption font-semibold">{move.short} <ArrowRight aria-hidden="true" className="size-3.5" /></Link>
          ) : (
            <button type="button" onClick={move.kind === "watch" ? onFiles : move.kind === "choose" ? onChoose : onFollow} aria-label={move.label} title={move.label} className="kc-pill inline-flex min-h-9 shrink-0 items-center gap-2 px-3 text-caption font-semibold">
              {move.short} <ArrowRight aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </div>
      </section>

      <p className="kc-room-muted text-center text-caption">Made with Meridian{project ? ` · ${MODE_COPY[project.mode].label} mode` : ""}</p>
      <div className="flex justify-center gap-2">
        <button type="button" onClick={onBrief} aria-label="Open the brief" title="The brief" className="kc-tile grid size-10 place-items-center"><Info aria-hidden="true" className="size-4" /></button>
        <Link to="/settings" aria-label="Settings: the models each step uses" title="Settings" className="kc-tile grid size-10 place-items-center"><Settings aria-hidden="true" className="size-4" /></Link>
        <button type="button" onClick={() => void copyLink()} aria-label="Copy the link to this canvas" title="Copy the link" className="kc-tile grid size-10 place-items-center"><Link2 aria-hidden="true" className="size-4" /></button>
      </div>
    </aside>
  );
}
