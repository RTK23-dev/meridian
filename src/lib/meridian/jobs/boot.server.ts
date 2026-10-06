import type { Sql } from "@/lib/db";
import { markWorkerLoopRunning } from "./state.ts";
import { tickSqlJobs } from "./sql-worker.ts";

/** Starts the in-process worker once. Preview Postgres is in-memory, so a second process cannot see it. */
export function ensureDurableWorker(sql: Sql): void {
  const flag = globalThis as { __meridianWorkerBooted?: boolean };
  if (flag.__meridianWorkerBooted) return;
  flag.__meridianWorkerBooted = true;
  markWorkerLoopRunning();
  const tick = () => {
    void tickSqlJobs(sql).catch((error) => {
      console.error("[worker]", error instanceof Error ? error.message : "Worker tick failed.");
    });
  };
  const timer = setInterval(tick, 5000);
  timer.unref?.();
  tick();
}

