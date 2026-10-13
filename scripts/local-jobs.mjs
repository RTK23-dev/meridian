// @ts-check
/**
 * The job loop for a local trial. It runs only inside the Vite dev server, and only when DATABASE_URL is unset.
 *
 * Without DATABASE_URL the web app opens the embedded PGlite database in its own process, and `npm run worker` cannot open the
 * same files: PGlite is single-writer. So the dev server runs the queued jobs itself, one pass at a time, through the same
 * `tickSqlJobs` the worker uses. vite.config.ts (localJobsPlugin) wires `runTick` to the web app's own database instance.
 *
 * A failed pass is logged and retried after a back-off. It never stops the dev server.
 */

export const LOCAL_JOB_INTERVAL_MS = 5000;
export const LOCAL_JOB_MAX_BACKOFF_MS = 60000;

/**
 * True when the local job loop should run: DATABASE_URL is unset or blank. A set URL means a worker process runs the jobs.
 * @param {Record<string, string | undefined>} env
 */
export function localJobsEnabled(env) {
  const url = env.DATABASE_URL;
  return !(typeof url === "string" && url.trim() !== "");
}

/**
 * @typedef {{ claimed: number, stopped: boolean }} PassResult
 * @typedef {{
 *   runTick: () => Promise<PassResult | undefined>,
 *   log?: (message: string) => void,
 *   logError?: (message: string) => void,
 *   intervalMs?: number,
 *   maxBackoffMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 * }} RunnerOptions
 */

/**
 * @param {RunnerOptions} options
 */
export function createLocalJobRunner(options) {
  const {
    runTick,
    log = (message) => console.log(message),
    logError = (message) => console.error(message),
    intervalMs = LOCAL_JOB_INTERVAL_MS,
    maxBackoffMs = LOCAL_JOB_MAX_BACKOFF_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = options;

  /** @type {any} */
  let timer = null;
  let stopped = false;
  let failures = 0;

  /** @param {number} delay */
  function schedule(delay) {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      void pass();
    }, delay);
    // The timer must not keep a process alive on its own. The dev server keeps it alive, and a stop clears it.
    timer?.unref?.();
  }

  /** One pass over the due jobs, then the next one is scheduled. It does not throw. */
  async function pass() {
    if (stopped) return;
    let delay = intervalMs;
    try {
      const result = await runTick();
      if (failures > 0) log("[jobs] The job pass works again.");
      failures = 0;
      const claimed = result?.claimed ?? 0;
      if (claimed > 0) log(`[jobs] Ran ${claimed} job${claimed === 1 ? "" : "s"}.`);
    } catch (error) {
      failures += 1;
      delay = Math.min(intervalMs * 2 ** Math.min(failures, 6), maxBackoffMs);
      const message = error instanceof Error ? error.message : String(error);
      logError(`[jobs] A job pass failed (${failures} in a row): ${message}`);
      if (failures === 1 && error instanceof Error && error.stack) logError(error.stack);
      logError(
        `[jobs] The dev server keeps running. The next pass runs in ${Math.round(delay / 1000)} s.`,
      );
    }
    schedule(delay);
  }

  return {
    /** Logs what is running, then runs the first pass now. */
    start() {
      log(
        `[jobs] Running queued jobs inside this dev server, every ${Math.round(intervalMs / 1000)} s. ` +
          "DATABASE_URL is not set, so no worker process is needed for this local trial.",
      );
      void pass();
    },
    /** Stops the loop. A pass already in flight finishes, and nothing is scheduled after it. */
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    /** One pass now, for tests. */
    runOnce: pass,
  };
}
