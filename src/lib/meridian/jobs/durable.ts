import { nextJobState } from "./transitions.ts";

export type DurableStatus = "queued" | "running" | "retry" | "succeeded" | "dead" | "cancelled";

export type DurableJob = {
  id: string;
  organizationId: string;
  brandId: string;
  type: string;
  idempotencyKey: string;
  payload: unknown;
  status: DurableStatus;
  attempts: number;
  maxAttempts: number;
  priority: number;
  runAfter: number;
  leaseUntil: number;
  lastError: string;
  result: string;
  logs: string[];
  cancelRequested: boolean;
  dependsOn: string;
};

export type JobSchedule = {
  id: string;
  organizationId: string;
  brandId: string;
  type: string;
  everyMs: number;
  nextRun: number;
  enabled: boolean;
};

const OPEN = new Set<DurableStatus>(["queued", "running", "retry", "succeeded"]);

function log(job: DurableJob, clock: number, message: string) {
  job.logs = [...job.logs, `${clock}:${message}`].slice(-20);
}

/**
 * In-memory durable queue. The SQL worker uses the same transitions:
 * lease, heartbeat, idempotency, dead-letter, and restart recovery.
 */
export function createDurableQueue() {
  const jobs: DurableJob[] = [];
  const schedules: JobSchedule[] = [];
  let sequence = 0;

  function byId(id: string): DurableJob {
    const job = jobs.find((item) => item.id === id);
    if (!job) throw new Error("Job not found.");
    return job;
  }

  return {
    jobs,
    schedules,
    enqueue(input: {
      organizationId: string;
      brandId: string;
      type: string;
      idempotencyKey: string;
      payload: unknown;
      priority?: number;
      runAfter?: number;
      maxAttempts?: number;
      dependsOn?: string;
    }) {
      const existing = jobs.find((job) => job.organizationId === input.organizationId && job.idempotencyKey === input.idempotencyKey && OPEN.has(job.status));
      if (existing) return { created: false as const, job: existing };
      const job: DurableJob = {
        id: `job-${++sequence}`,
        organizationId: input.organizationId,
        brandId: input.brandId,
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        status: "queued",
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        priority: input.priority ?? 100,
        runAfter: input.runAfter ?? 0,
        leaseUntil: 0,
        lastError: "",
        result: "",
        logs: [],
        cancelRequested: false,
        dependsOn: input.dependsOn ?? "",
      };
      jobs.push(job);
      return { created: true as const, job };
    },
    schedule(input: Omit<JobSchedule, "enabled"> & { enabled?: boolean }) {
      schedules.push({ ...input, enabled: input.enabled ?? true });
    },
    recover(clock: number) {
      let recovered = 0;
      for (const job of jobs) {
        if (job.status !== "running" || job.leaseUntil > clock) continue;
        recovered += 1;
        if (job.attempts >= job.maxAttempts) {
          job.status = "dead";
          job.lastError = job.lastError || "Lease expired after the last attempt.";
        } else {
          job.status = "retry";
          job.runAfter = clock;
          job.lastError = "Lease expired before the worker finished.";
        }
        job.leaseUntil = 0;
        log(job, clock, "recovered");
      }
      return recovered;
    },
    claim(clock: number, limit: number, leaseMs: number) {
      const ready = jobs
        .filter((job) => {
          if (job.cancelRequested && (job.status === "queued" || job.status === "retry")) {
            job.status = "cancelled";
            log(job, clock, "cancelled");
            return false;
          }
          if ((job.status !== "queued" && job.status !== "retry") || job.runAfter > clock) return false;
          if (job.dependsOn) {
            const parent = jobs.find((item) => item.id === job.dependsOn);
            if (!parent || parent.status !== "succeeded") return false;
          }
          return true;
        })
        .sort((a, b) => a.priority - b.priority || a.runAfter - b.runAfter);
      const claimed = ready.slice(0, limit);
      for (const job of claimed) {
        job.status = "running";
        job.attempts += 1;
        job.leaseUntil = clock + leaseMs;
        log(job, clock, "claimed");
      }
      return claimed.map((job) => ({ ...job, payload: job.payload }));
    },
    heartbeat(id: string, clock: number, leaseMs: number) {
      const job = byId(id);
      if (job.status !== "running") return;
      job.leaseUntil = clock + leaseMs;
      log(job, clock, "heartbeat");
    },
    succeed(id: string, clock: number, result: string) {
      const job = byId(id);
      job.status = "succeeded";
      job.result = result;
      job.leaseUntil = 0;
      job.lastError = "";
      log(job, clock, "succeeded");
    },
    fail(id: string, clock: number, error: string) {
      const job = byId(id);
      const next = nextJobState({ attempts: job.attempts - 1, maxAttempts: job.maxAttempts, failed: true, clock });
      job.attempts = next.attempts;
      job.status = next.status;
      job.runAfter = next.runAfter;
      job.leaseUntil = 0;
      job.lastError = error;
      log(job, clock, next.status);
    },
    cancel(id: string, clock: number) {
      const job = byId(id);
      if (job.status === "succeeded" || job.status === "dead" || job.status === "cancelled") return job;
      if (job.status === "running") {
        job.cancelRequested = true;
        log(job, clock, "cancel requested");
        return job;
      }
      job.status = "cancelled";
      log(job, clock, "cancelled");
      return job;
    },
    fireSchedules(clock: number) {
      const created: DurableJob[] = [];
      for (const schedule of schedules) {
        if (!schedule.enabled || schedule.nextRun > clock) continue;
        const key = `schedule:${schedule.id}:${schedule.nextRun}`;
        const queued = this.enqueue({
          organizationId: schedule.organizationId,
          brandId: schedule.brandId,
          type: schedule.type,
          idempotencyKey: key,
          payload: { scheduleId: schedule.id },
          runAfter: schedule.nextRun,
        });
        if (queued.created) created.push(queued.job);
        schedule.nextRun += schedule.everyMs;
      }
      return created;
    },
  };
}

export type DurableQueue = ReturnType<typeof createDurableQueue>;

export async function runWorkerTick(
  queue: DurableQueue,
  handlers: Record<string, (job: DurableJob) => Promise<string> | string>,
  clock: number,
  options?: { limit?: number; leaseMs?: number },
): Promise<{ ran: string[]; recovered: number }> {
  const leaseMs = options?.leaseMs ?? 30_000;
  queue.fireSchedules(clock);
  const recovered = queue.recover(clock);
  const claimed = queue.claim(clock, options?.limit ?? 4, leaseMs);
  const ran: string[] = [];
  for (const snapshot of claimed) {
    const payload = snapshot.payload;
    if (payload && typeof payload === "object" && "organizationId" in payload) {
      const foreign = (payload as { organizationId?: string }).organizationId;
      if (foreign && foreign !== snapshot.organizationId) {
        queue.fail(snapshot.id, clock, "Tenant scope violation.");
        continue;
      }
    }
    const current = queue.jobs.find((job) => job.id === snapshot.id);
    if (current?.cancelRequested) {
      current.status = "cancelled";
      current.leaseUntil = 0;
      continue;
    }
    try {
      const handler = handlers[snapshot.type];
      if (!handler) throw new Error(`No handler for ${snapshot.type}.`);
      queue.heartbeat(snapshot.id, clock, leaseMs);
      const result = await handler(snapshot);
      queue.succeed(snapshot.id, clock, result);
      ran.push(snapshot.id);
    } catch (error) {
      queue.fail(snapshot.id, clock, error instanceof Error ? error.message : "Job failed.");
    }
  }
  return { ran, recovered };
}
