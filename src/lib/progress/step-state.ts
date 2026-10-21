/** done: finished. current: the step on screen. todo: not finished yet. stale: finished, but it depends on a step that changed. */
export type StepStatus = "done" | "current" | "todo" | "stale";

export type StepGraph = {
  /** Step ids in the order the person goes through them. */
  order: readonly string[];
  /** Each step lists the steps it reads from: its direct dependencies. */
  dependsOn: Readonly<Record<string, readonly string[]>>;
};

/**
 * The status of each step. The current step is "current" even when it is also finished, so the step bar shows where the
 * person is. A finished step is "stale" when it depends, directly or through other steps, on a changed step. A step that
 * is neither finished nor current is "todo".
 */
export function stepStatuses(
  input: StepGraph & { current: string; done: readonly string[]; changed: readonly string[] },
): Record<string, StepStatus> {
  const stale = staleSteps(input.dependsOn, input.changed);
  const finished = new Set(input.done);
  const statuses: Record<string, StepStatus> = {};
  for (const step of input.order) {
    if (step === input.current) statuses[step] = "current";
    else if (finished.has(step)) statuses[step] = stale.has(step) ? "stale" : "done";
    else statuses[step] = "todo";
  }
  return statuses;
}

/** Every step that reaches a changed step through its dependencies, found by walking from each changed step to the steps that read from it. */
function staleSteps(dependsOn: Readonly<Record<string, readonly string[]>>, changed: readonly string[]): Set<string> {
  const readers = new Map<string, string[]>();
  for (const [step, sources] of Object.entries(dependsOn)) {
    for (const source of sources) {
      readers.set(source, [...(readers.get(source) ?? []), step]);
    }
  }
  const stale = new Set<string>();
  const queue = [...changed];
  for (const from of queue) {
    for (const next of readers.get(from) ?? []) {
      if (!stale.has(next)) {
        stale.add(next);
        queue.push(next);
      }
    }
  }
  return stale;
}

/**
 * Finished steps and the current step can always be opened. A step that is not finished can be opened only when every
 * step before it in the order is finished. A step that is not in the order cannot be opened.
 */
export function canJumpTo(step: string, state: { order: readonly string[]; done: readonly string[]; current: string }): boolean {
  const index = state.order.indexOf(step);
  if (index === -1) return false;
  if (step === state.current || state.done.includes(step)) return true;
  return state.order.slice(0, index).every((earlier) => state.done.includes(earlier));
}

/** The step after this one in the order, or null at the end or for an unknown step. */
export function nextStep(step: string, order: readonly string[]): string | null {
  const index = order.indexOf(step);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : null;
}

/** The step before this one in the order, or null at the start or for an unknown step. */
export function prevStep(step: string, order: readonly string[]): string | null {
  const index = order.indexOf(step);
  return index > 0 ? order[index - 1] : null;
}
