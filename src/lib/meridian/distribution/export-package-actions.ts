import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { hasRole, isRole } from "@/lib/meridian/access";
import { buildExportPackage, type ExportPackage } from "./export-package.ts";
import { gateForCreative, plainReasons } from "./export-gate.ts";

// The export package of one creative, run through the disclosure check. The package is returned only when the check passes, so a
// blocked creative's files and copy never leave the server. A member may check a creative in their own workspace.

export type ExportCheck = { package: ExportPackage | null; passed: boolean; reasons: string[] };

export type ExportCheckInput = { organizationId: string; brandId: string; creativeId: string };

function checkInput(input: unknown): ExportCheckInput {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const field = (name: string, max: number) => {
    const text = typeof value[name] === "string" ? (value[name] as string).trim() : "";
    if (!text || text.length > max) throw new Error(`Choose a valid ${name}.`);
    return text;
  };
  return {
    organizationId: field("organizationId", 100),
    brandId: field("brandId", 100),
    creativeId: field("creativeId", 100),
  };
}

/** Checks one creative's export package. The caller must be a member of the workspace, and the creative must be in the brand. */
export async function checkExport(sql: Sql, userId: string, input: ExportCheckInput): Promise<ExportCheck> {
  const memberships = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${input.organizationId} limit 1
  `;
  const role = memberships[0]?.role;
  if (!role || !isRole(role) || !hasRole(role, "viewer")) throw new Error("This workspace is not available to you.");
  const pkg = await buildExportPackage(sql, { organizationId: input.organizationId, brandId: input.brandId }, input.creativeId);
  if (!pkg) return { package: null, passed: false, reasons: ["This creative is not in this brand."] };
  const gate = gateForCreative(pkg.creativeId);
  return { package: gate.passed ? pkg : null, passed: gate.passed, reasons: plainReasons(gate) };
}

export const checkExportPackage = createServerFn({ method: "POST" })
  .validator((input: unknown) => checkInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    return checkExport(sql, context.userId, data);
  });
