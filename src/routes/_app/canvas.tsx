import { createFileRoute } from "@tanstack/react-router";
import { VideoCanvas } from "@/components/canvas/video-canvas";

type CanvasSearch = { project?: string };

function canvasSearchOf(search: Record<string, unknown>): CanvasSearch {
  const project = search.project;
  return typeof project === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(project) ? { project } : {};
}

/**
 * The video canvas: a video project made with Meridian (by a chat or Claude Code) as a board of connected steps. `?project=<id>` opens one
 * video; without it the newest opens.
 */
export const Route = createFileRoute("/_app/canvas")({
  staticData: { pageTitle: "Canvas" },
  validateSearch: canvasSearchOf,
  component: CanvasRoute,
});

function CanvasRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="page-title">Canvas</h1>
        <p className="text-sm text-fg-muted">Follow a video while the chat makes it, or choose each step yourself.</p>
      </header>
      <VideoCanvas projectId={search.project ?? null} onProject={(id) => void navigate({ search: id ? { project: id } : {}, replace: true })} />
    </div>
  );
}
