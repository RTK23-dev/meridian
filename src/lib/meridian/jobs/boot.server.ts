/** The web process must not claim jobs. Start scripts/worker-entry.ts instead. */
export function ensureDurableWorker(): void {
  throw new Error("The web process does not run the worker. Start the worker process.");
}