/**
 * Learning Guardrails
 *
 * Strictly prevents synthetic test fixtures, simulations, or fixture mocks
 * from contaminating real learned priors, model parameters, or calibration distributions.
 */

import type { ObservedCreative, PerformanceRow } from "../domain.ts";

export function isSyntheticOrTestRecord(record: Record<string, unknown> | null | undefined): boolean {
  if (!record || typeof record !== "object") return false;

  const id = String(record.id ?? record.creativeId ?? record.sourceId ?? "");
  const name = String(record.name ?? record.title ?? "");
  const provider = String(record.provider ?? record.sourceAdapter ?? "");

  // Synthetic & fixture markers
  if (
    id.startsWith("fixture-") ||
    id.startsWith("mock-") ||
    id.startsWith("synthetic-") ||
    id.includes("test_")
  ) {
    return true;
  }

  if (
    name.toLowerCase().includes("fixture") ||
    name.toLowerCase().includes("synthetic") ||
    name.toLowerCase().includes("simulated")
  ) {
    return true;
  }

  if (provider === "fixture" || provider === "timeline" || provider === "mock") {
    return true;
  }

  if (record.isSynthetic === true || record.isTest === true || record.isSimulated === true) {
    return true;
  }

  return false;
}

export function assertLearnableRecord(record: Record<string, unknown>): void {
  if (isSyntheticOrTestRecord(record)) {
    throw new Error(
      `Synthetic or test record (${String(record.id || "unnamed")}) cannot be ingested into production learning.`,
    );
  }
}

export function filterLearnablePerformance(rows: PerformanceRow[]): PerformanceRow[] {
  return rows.filter((row) => !isSyntheticOrTestRecord(row as unknown as Record<string, unknown>));
}

export function filterLearnableObservations(creatives: ObservedCreative[]): ObservedCreative[] {
  return creatives.filter((c) => !isSyntheticOrTestRecord(c as unknown as Record<string, unknown>));
}
