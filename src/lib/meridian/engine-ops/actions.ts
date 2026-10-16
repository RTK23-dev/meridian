import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { deadJobsInput, replayInput, stageMetricsInput } from "./input.ts";
import { readRequestDeadJobs, readWorkspaceStageMetrics, replayRequestDeadJob } from "./service.ts";

// The video engine's operations surface (Video Engine Bible 15.3, 5.2). The checks are in service.ts; these functions only take the
// session's user and the database.

/** Stage metrics of one workspace: stage durations, gate pass rates, provider health, cost and the queue. Any member may read them. */
export const getEngineStageMetrics = createServerFn({ method: "POST" })
  .validator((input: unknown) => stageMetricsInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return readWorkspaceStageMetrics(sql, context.userId, data);
  });

/** The dead engine jobs of one request, oldest first. Any member of the request's workspace may read them. */
export const listEngineDeadJobs = createServerFn({ method: "POST" })
  .validator((input: unknown) => deadJobsInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return readRequestDeadJobs(sql, context.userId, data);
  });

/** Replays one dead job of a request. Admins of the request's workspace only; the workspace comes from the request, not the input. */
export const replayEngineDeadJob = createServerFn({ method: "POST" })
  .validator((input: unknown) => replayInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return replayRequestDeadJob(sql, context.userId, data);
  });
