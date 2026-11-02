// The billing page's server functions. Each one checks the caller's membership (and, for a write, the admin role) inside the store, before it
// reads or writes anything. The page is the only screen that writes a limit.

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { asText, objectInput } from "../api-shared";
import { isLimitKind } from "./limits.ts";
import { readBillingPage, saveBillingLimit } from "./store.ts";

/** The billing page: every limit of the workspace and of each brand. Any member may read it. */
export const getBillingPage = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => readBillingPage(await getSql(), { userId: context.userId, organizationId: data.organizationId }));

/** Saves, or clears with a blank value, one limit. Only an admin of the workspace may change it; the role is checked on the server. */
export const saveBillingLimitAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    if (!isLimitKind(obj.kind)) throw new Error("That limit is not on the billing page.");
    const kind = obj.kind;
    const brandId = obj.brandId === undefined || obj.brandId === null || obj.brandId === "" ? null : asText(obj.brandId);
    const value = obj.value;
    if (value !== null && value !== undefined && typeof value !== "string" && typeof value !== "number") {
      throw new Error("The value must be a number, or blank to clear it.");
    }
    return { organizationId, kind, brandId, value: (value ?? null) as string | number | null };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) =>
    saveBillingLimit(await getSql(), {
      userId: context.userId,
      organizationId: data.organizationId,
      kind: data.kind,
      brandId: data.brandId,
      value: data.value,
    }),
  );
