// Job settings that engine/config does not hold yet (Video Engine Bible 5.1 and 15.2). Every value is initial. Timeouts,
// attempts and redo limits are read from engine/config/thresholds.ts; this file only adds what the config lacks: the
// priority numbers, the poll backoff and the poll schedule. STATUS.md asks the config owner to move them into thresholds.

export type RequestPriority = "rush" | "normal" | "batch";

export const jobSettings = {
  version: "jobs-settings@1",

  // 5.1: rush before normal before batch. Meridian's jobs.priority runs the lowest number first.
  priority: { rush: 10, normal: 100, batch: 1000 } as Record<RequestPriority, number>,

  // 15.2: async provider calls. A worker submits, stores the external job reference and releases its lease. A poll job
  // then checks again after a backoff: initialMs, then multiplied by factor each step, capped at maxMs.
  poll: { initialMs: 5_000, factor: 2, maxMs: 60_000 },

  // 6.2 analyze_reference: "retries once with denser frames", then the request is escalated. Bible rule, no config key.
  analyzeRetries: 1,

  // 10.4: a content_policy or invalid_input refusal gets one planner rewrite of the prompt, then the shot is downgraded.
  promptRewrites: 1,
} as const;
