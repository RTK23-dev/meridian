// The figures of Home's studio row, pure so they are tested without a browser. Each counts the workspace's own video projects.
import { PROJECT_MODES, type ProjectMode, type ProjectStatus } from "../../lib/meridian/mcp/workflow.ts";

export type StudioCounts = { active: number; delivered: number; stopped: number; byMode: Record<ProjectMode, number> };

export function studioCounts(projects: ReadonlyArray<{ mode: ProjectMode; status: ProjectStatus }>): StudioCounts {
  const byMode = Object.fromEntries(PROJECT_MODES.map((mode) => [mode, projects.filter((project) => project.mode === mode).length])) as Record<ProjectMode, number>;
  return {
    active: projects.filter((project) => project.status === "active").length,
    delivered: projects.filter((project) => project.status === "delivered").length,
    stopped: projects.filter((project) => project.status === "abandoned").length,
    byMode,
  };
}
