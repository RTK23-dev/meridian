import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { readinessResponse } from "@/lib/meridian/ops/health";

/**
 * GET /api/ready is readiness for uptime monitors and load balancers: 200 when the database answers, every migration is applied and the
 * job queue is moving; 503 otherwise. The body names each check and its state and nothing else. GET /api/health stays liveness.
 */
export const Route = createFileRoute("/api/ready")({
  server: {
    handlers: {
      GET: async () => readinessResponse(getSql),
    },
  },
});
