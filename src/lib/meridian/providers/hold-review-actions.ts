// The server functions an administrator's screen uses for uncertain budget holds. The role and membership checks are in hold-review.ts,
// which is tested on its own; these functions only read the signed-in user and the workspace the screen names.

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { objectInput, asText } from "../api-shared.ts";
import { listUncertainHoldsAs, releaseHoldAs } from "./hold-review.ts";

export const getUncertainGenerationHolds = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return { holds: await listUncertainHoldsAs(sql, { userId: context.userId, organizationId: data.organizationId }) };
  });

export const releaseGenerationHold = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const holdId = asText(obj.holdId);
    const reason = asText(obj.reason);
    if (!organizationId) throw new Error("organizationId is required.");
    if (!holdId) throw new Error("holdId is required.");
    return { organizationId, holdId, reason };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return releaseHoldAs(sql, { userId: context.userId, organizationId: data.organizationId, holdId: data.holdId, reason: data.reason });
  });
