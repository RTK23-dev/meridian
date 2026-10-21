import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { readSystemStatus } from "@/lib/meridian/system-status";

export const getSystemStatus = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { organizationId?: unknown }) : {};
    return { organizationId: typeof body.organizationId === "string" ? body.organizationId : "" };
  })
  .middleware([authMiddleware])
  .handler(({ context, data }) => readSystemStatus({ userId: context.userId, organizationId: data.organizationId, loadSql: getSql }));
