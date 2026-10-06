const globalState = globalThis as typeof globalThis & { __meridianWorkerStarted?: boolean };

export function markWorkerLoopRunning(): void {
  globalState.__meridianWorkerStarted = true;
}

export function isWorkerLoopRunning(): boolean {
  return Boolean(globalState.__meridianWorkerStarted);
}
