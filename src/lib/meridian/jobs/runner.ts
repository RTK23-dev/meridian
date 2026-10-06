export type JobStatus = "queued" | "running" | "succeeded" | "retry" | "dead";

export type Job = {
  id: string;
  type: string;
  idempotencyKey: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  lastError: string;
};

const OPEN = new Set<JobStatus>(["queued", "running", "retry", "succeeded"]);

/**
 * In-process job queue with retries and idempotency.
 * The web process does not run this on a timer. Callers drain it.
 */
export function createJobQueue() {
  const jobs: Job[] = [];
  let sequence = 0;

  return {
    jobs,
    enqueue(type: string, idempotencyKey: string, payload: unknown, maxAttempts = 3) {
      const existing = jobs.find((job) => job.idempotencyKey === idempotencyKey && OPEN.has(job.status));
      if (existing) return { created: false as const, job: existing };
      const job: Job = {
        id: `job-${++sequence}`,
        type,
        idempotencyKey,
        payload,
        status: "queued",
        attempts: 0,
        maxAttempts,
        runAfter: 0,
        lastError: "",
      };
      jobs.push(job);
      return { created: true as const, job };
    },
    drain(handlers: Record<string, (payload: unknown) => void>, clock: number) {
      const ready = jobs.filter((job) => (job.status === "queued" || job.status === "retry") && job.runAfter <= clock);
      const results: { id: string; status: JobStatus }[] = [];
      for (const job of ready) {
        job.status = "running";
        job.attempts += 1;
        try {
          const handler = handlers[job.type];
          if (!handler) throw new Error(`No handler for ${job.type}.`);
          handler(job.payload);
          job.status = "succeeded";
          job.lastError = "";
        } catch (error) {
          job.lastError = error instanceof Error ? error.message : "Job failed.";
          if (job.attempts >= job.maxAttempts) {
            job.status = "dead";
          } else {
            job.status = "retry";
            job.runAfter = clock + 1000 * 2 ** (job.attempts - 1);
          }
        }
        results.push({ id: job.id, status: job.status });
      }
      return results;
    },
  };
}

export function learningJobKey(observationId: string): string {
  return `performance.recorded:${observationId}`;
}
