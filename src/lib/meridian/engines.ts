import { videoEngineById, type VideoEngine } from "./video/engine.ts";
import { gradingEngineById, type GradingEngine } from "./grading/engine.ts";
import { plannerEngineById, type PlannerEngine } from "./planner/engine.ts";
import { publishEngineById, type PublishEngine } from "./publishing/engine.ts";
import { sourceAdapterById, type SourceAdapter } from "./factory/sources.ts";

export type MeridianEngines = {
  video: VideoEngine;
  grading: GradingEngine;
  planner: PlannerEngine;
  publish: PublishEngine;
  sources: SourceAdapter;
};

export type MeridianEnginesConfig = {
  video?: string | VideoEngine;
  grading?: string | GradingEngine;
  planner?: string | PlannerEngine;
  publish?: string | PublishEngine;
  sources?: string | SourceAdapter;
};

export function createMeridianEngines(config: MeridianEnginesConfig = {}): MeridianEngines {
  const video = typeof config.video === "object" ? config.video : videoEngineById(config.video ?? "timeline");
  const grading = typeof config.grading === "object" ? config.grading : gradingEngineById(config.grading ?? "winner_score");
  const planner = typeof config.planner === "object" ? config.planner : plannerEngineById(config.planner ?? "matrix");
  const publish = typeof config.publish === "object" ? config.publish : publishEngineById(config.publish ?? "test");
  const sources = typeof config.sources === "object" ? config.sources : sourceAdapterById(config.sources ?? "bulk-upload");

  return {
    video,
    grading,
    planner,
    publish,
    sources,
  };
}

export { videoEngineById, type VideoEngine } from "./video/engine.ts";
export { gradingEngineById, registerGradingEngine, type GradingEngine } from "./grading/engine.ts";
export { plannerEngineById, registerPlannerEngine, type PlannerEngine } from "./planner/engine.ts";
export { publishEngineById, registerPublishEngine, type PublishEngine } from "./publishing/engine.ts";
export { sourceAdapterById, type SourceAdapter } from "./factory/sources.ts";
