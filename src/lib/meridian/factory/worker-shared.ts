// Small helpers that the factory worker and its modules share. Moved out of factory/worker.ts unchanged (coding loop, T5).

import type { Sql } from "../learning/store.ts";
import { adsMustPause } from "./kill-switch.ts";

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function killSwitchPaused(sql: Sql, organizationId: string, brandId: string): Promise<boolean> {
  const rows = await sql<{ scope: string; engaged: boolean }>`
    select scope, engaged from factory_kill_switches
    where organization_id = ${organizationId} and (brand_id is null or brand_id = ${brandId})
  `;
  return adsMustPause({
    workspaceEngaged: rows.some((row) => row.scope === "workspace" && row.engaged),
    brandEngaged: rows.some((row) => row.scope === "brand" && row.engaged),
  });
}
