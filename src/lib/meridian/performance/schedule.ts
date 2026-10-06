import type { ConnectionPhase } from "../providers/phase.ts";

/** Only a healthy Meta connection gets a performance schedule. The scheduler enqueues it. The worker runs it. */
export function performanceScheduleDecision(input: {
  provider: string;
  phase: ConnectionPhase;
  disconnected: boolean;
}): { enabled: boolean; reason: string } {
  if (input.disconnected) return { enabled: false, reason: "A disconnected provider is not scheduled." };
  if (input.provider !== "meta") {
    return { enabled: false, reason: "Only Meta has a performance client. TikTok and Google are not scheduled." };
  }
  if (input.phase !== "HEALTHY" && input.phase !== "CONNECTED") {
    return { enabled: false, reason: "Performance sync waits for a successful provider request." };
  }
  return { enabled: true, reason: "Enqueue performance.sync on the cadence. Do not run it in the web process." };
}

export function performanceScheduleId(organizationId: string, brandId: string): string {
  return `perf:${organizationId}:${brandId}:meta`;
}
