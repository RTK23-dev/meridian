/** A draft is saved this long after the last change. */
export const DRAFT_SAVE_DELAY_MS = 600;

export type DebounceTimers<Handle> = {
  setTimer(run: () => void, ms: number): Handle;
  clearTimer(handle: Handle): void;
};

/**
 * Runs the latest call once, ms after the last call. The timers are injected, so tests run on fake timers.
 * flush runs a waiting call now. cancel drops it without running it.
 */
export function createDebouncer<Handle>(ms: number, timers: DebounceTimers<Handle>) {
  let pending: (() => void) | null = null;
  let timer: { handle: Handle } | null = null;

  function fire() {
    const run = pending;
    pending = null;
    timer = null;
    run?.();
  }

  return {
    call(run: () => void) {
      if (timer) timers.clearTimer(timer.handle);
      pending = run;
      timer = { handle: timers.setTimer(fire, ms) };
    },
    flush() {
      if (!timer) return;
      timers.clearTimer(timer.handle);
      fire();
    },
    cancel() {
      if (timer) timers.clearTimer(timer.handle);
      pending = null;
      timer = null;
    },
  };
}
