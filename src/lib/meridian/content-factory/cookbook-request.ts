// Putting a resolved cookbook into a Content Factory request (round 3, K12). It uses the fields the engine already reads (no contract change):
// the style kit (when the cookbook names one; otherwise the theme page's kit stands), the length as a cap, and the cookbook's instructions,
// which join the brief's text (or, for a script request, the change lines). The result is parsed again by the engine's own schema, so a request
// that no longer fits is reported as incomplete with its problem, never cut.

import { productionRequestSchema, type ProductionRequest } from "../../../engine/contracts/request.ts";
import type { ResolvedCookbook } from "../cookbooks/resolve.ts";
import type { RequestBuild } from "./request.ts";

const COOKBOOK_HEADER = "Cookbook instructions";

/** The instructions of a resolved cookbook, one line per role instruction, under a header. Null when the cookbook has none. */
export function cookbookInstructionLines(resolved: ResolvedCookbook): string[] {
  const lines: string[] = [];
  for (const [role, texts] of Object.entries(resolved.instructions)) {
    for (const text of texts ?? []) lines.push(`${role}: ${text.replace(/\s+/g, " ").trim()}`);
  }
  return lines;
}

/** Applies a resolved cookbook to a request. Pure: the input is not changed. */
export function applyCookbook(build: RequestBuild, resolved: ResolvedCookbook): RequestBuild {
  const candidate: Record<string, unknown> = structuredClone(build.status === "ready" ? (build.request as unknown as Record<string, unknown>) : build.candidate);
  const lines = cookbookInstructionLines(resolved);
  const header = `${COOKBOOK_HEADER} (${resolved.label}, version ${resolved.version}). They shape this video. They never override the engine's rules or its gates.`;

  const page = (candidate.page ?? {}) as Record<string, unknown>;
  if (resolved.request.styleKitId !== null) candidate.page = { ...page, styleKitId: resolved.request.styleKitId };

  const constraints = (candidate.constraints ?? {}) as Record<string, unknown>;
  const cap = typeof constraints.maxMs === "number" ? Math.min(constraints.maxMs, resolved.request.lengthMs) : resolved.request.lengthMs;
  candidate.constraints = { ...constraints, maxMs: cap };

  if (lines.length > 0) {
    if (candidate.brief !== undefined) {
      const brief = candidate.brief as Record<string, unknown>;
      const existing = typeof brief.text === "string" ? brief.text : "";
      candidate.brief = { ...brief, text: [existing, [header, ...lines].join("\n")].filter((part) => part !== "").join("\n\n") };
    } else {
      const format = (candidate.format ?? {}) as Record<string, unknown>;
      const change = Array.isArray(format.change) ? (format.change as unknown[]) : [];
      candidate.format = { ...format, change: [...change, header, ...lines] };
    }
  }

  const parsed = productionRequestSchema.safeParse(candidate);
  if (parsed.success) return { status: "ready", request: parsed.data as ProductionRequest };
  const problems = parsed.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path === "brief.text" ? "The cookbook's instructions do not fit the brief's limit. Shorten the brief or the instructions." : `${path || "request"}: ${issue.message}`;
  });
  return { status: "incomplete", candidate, problems: [...new Set(problems)] };
}
