import { Link } from "@tanstack/react-router";
import { ArrowRight, Plus } from "lucide-react";
import { DotMatrix } from "@/components/canvas/dot-matrix";
import { MODE_LETTER } from "@/components/canvas/canvas-model";
import { useVideoProjectsQuery } from "@/lib/query/hooks";
import { MODE_COPY, PHASE_COPY, PROJECT_MODES, type Phase } from "@/lib/meridian/mcp/workflow";
import { studioCounts } from "./studio-tiles-model";

const TILE = "surface-tile flex min-h-36 flex-col gap-3 border border-hairline p-4";
const HEAD = "flex items-center justify-between gap-2 text-small font-semibold text-fg-primary";
const ROUND = "grid size-9 shrink-0 place-items-center rounded-full bg-overlay text-fg-primary hover:bg-white-accent hover:text-ground";

/**
 * The studio row on Home, in the canvas system: the dot-matrix wordmark with a sun that counts the videos being made, the latest video, the
 * videos by mode, and the delivered ones. Every figure is the workspace's own video projects; while they load, the figures say so.
 */
export function StudioTiles({ organizationId }: { organizationId: string }) {
  const projects = useVideoProjectsQuery(organizationId);
  const counts = projects.data ? studioCounts(projects.data) : null;
  const latest = projects.data?.[0] ?? null;
  const figure = (value: number | undefined) => (counts ? String(value ?? 0) : "…");

  return (
    <section aria-labelledby="studio-tiles" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <h2 id="studio-tiles" className="sr-only">Videos</h2>
      <div className="surface-tile col-span-2 flex flex-col gap-4 border border-hairline p-4 sm:p-6 xl:row-span-2">
        <DotMatrix text="Meridian" dot={3.2} gap={1.5} label="Meridian" fluid className="text-fg-primary" />
        <div className="flex flex-1 items-center gap-5">
          <div className="sun grid aspect-square w-28 shrink-0 place-items-center text-on-accent sm:w-36" aria-hidden="true">
            <DotMatrix text={counts ? String(Math.min(counts.active, 99)) : "0"} dot={4} gap={1.6} label="" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="font-display text-section font-semibold text-fg-primary">{counts ? `${counts.active} ${counts.active === 1 ? "video" : "videos"} in the making` : projects.isError ? "Videos could not be read" : "Reading the videos"}</p>
            <p className="text-small text-fg-muted">A chat or Claude Code makes each one with Meridian; the canvas follows it step by step.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/canvas" className="inline-flex min-h-10 items-center gap-2 rounded-full bg-white-accent px-4 text-button font-semibold text-ground hover:bg-fg-secondary">Open the canvas <ArrowRight aria-hidden="true" className="size-4" /></Link>
          <Link to="/create" search={{ way: "claude_code" }} aria-label="Make a new video" className="grid size-10 place-items-center rounded-full border border-hairline bg-overlay text-fg-primary hover:border-border-strong"><Plus aria-hidden="true" className="size-4" /></Link>
        </div>
      </div>

      <section aria-labelledby="studio-latest" className={`${TILE} col-span-2`}>
        <div className={HEAD}>
          <h3 id="studio-latest">Latest video</h3>
          {latest ? <Link to="/canvas" search={{ project: latest.id }} aria-label={`Open ${latest.title} on the canvas`} className={ROUND}><ArrowRight aria-hidden="true" className="size-4" /></Link> : null}
        </div>
        {latest ? (
          <div className="mt-auto space-y-1">
            <p className="line-clamp-2 font-display text-heading font-semibold text-fg-primary">{latest.title}</p>
            <p className="text-caption text-fg-muted">
              {MODE_COPY[latest.mode].label} · {latest.status === "active" ? (latest.phase ? `at ${PHASE_COPY[latest.phase as Phase]?.label ?? latest.phase}` : "every step settled") : latest.status} · {latest.brandName ?? "No brand"}
            </p>
          </div>
        ) : <p className="mt-auto text-small text-fg-muted">{projects.isPending ? "Reading the videos." : "No video yet. Start one from Create."}</p>}
      </section>

      <section aria-labelledby="studio-modes" className={TILE}>
        <h3 id="studio-modes" className={HEAD}>By mode</h3>
        <ul className="mt-auto space-y-2">
          {PROJECT_MODES.map((mode) => (
            <li key={mode} className="flex items-center justify-between gap-2 text-caption">
              <span className="flex items-center gap-2 text-fg-secondary"><DotMatrix text={MODE_LETTER[mode]} dot={1.8} gap={0.8} label="" className="text-fg-primary" />{MODE_COPY[mode].label}</span>
              <span className="font-mono text-fg-primary">{figure(counts?.byMode[mode])}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="studio-delivered" className={TILE}>
        <div className={HEAD}>
          <h3 id="studio-delivered">Delivered</h3>
          {counts && counts.delivered > 0 ? <span className="rounded-full bg-accent px-2 text-caption font-semibold text-on-accent">{counts.delivered}</span> : null}
        </div>
        <p className="mt-auto font-mono text-data-l text-fg-primary">{figure(counts?.delivered)}</p>
        <p className="text-caption text-fg-muted">{counts ? `${counts.stopped} stopped` : "Counting"}</p>
      </section>
    </section>
  );
}
