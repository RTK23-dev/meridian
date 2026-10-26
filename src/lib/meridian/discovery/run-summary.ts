import { socialPlatformOf } from "./source-capabilities.ts";
import type { SourceRunState } from "./types.ts";

/** The plain outcome of one discovery run. Each one reads differently, and "completed" never stands for "found something new". */
export type RunOutcome = "new_evidence" | "nothing_new" | "blocked" | "partial" | "nothing_ran";

export type RunSummaryInput = {
  discoveredUrls: number;
  seenBefore: number;
  /** What was asked for. Optional, so a run without it reads as before. */
  seeds?: readonly string[];
  sources: readonly SourceRunState[];
};

export type RunSummary = {
  outcome: RunOutcome;
  headline: string;
  /** What to do next, written for a person. Null when there is nothing to add. */
  nextStep: string | null;
  stored: number;
  alreadyStored: number;
  ran: number;
  /** Sources that were attempted and failed. */
  failed: number;
  /** Sources the run never used, because they are not connected or do not search this kind of input. Not failures. */
  notUsed: number;
  /** The most actionable reason a source failed, or null. */
  blocker: string | null;
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A page the site's robots.txt or a bot check kept Meridian from reading. Reported as it is, never worked around. */
function isPlatformBlock(reason: string): boolean {
  return /robots\.txt|bot check|challenge|not allow/i.test(reason);
}

/** Summarises one run for the default view. The per-source rows stay available behind a disclosure. */
export function summarizeRun(run: RunSummaryInput): RunSummary {
  const ran = run.sources.filter((source) => source.status === "ran").length;
  const failedSources = run.sources.filter((source) => source.status === "failed");
  const notUsed = run.sources.filter((source) => source.status === "not_configured" || source.status === "not_supported").length;
  const failed = failedSources.length;
  const blocker = failedSources.find((source) => isPlatformBlock(source.reason))?.reason ?? failedSources[0]?.reason ?? null;
  const base = { stored: run.discoveredUrls, alreadyStored: run.seenBefore, ran, failed, notUsed, blocker };

  if (run.discoveredUrls > 0) {
    const partial = failed > 0;
    return {
      ...base,
      outcome: partial ? "partial" : "new_evidence",
      headline: `${plural(run.discoveredUrls, "new example", "new examples")} stored${run.seenBefore > 0 ? `, ${run.seenBefore} already stored` : ""}.`,
      nextStep: partial ? "Some sources did not work. Open the source details to see which." : "Review what was stored below.",
    };
  }
  // A source ran and another failed: the run is partial, and the failure keeps its next action. Blocked means no source ran.
  if (ran > 0 && failed > 0) {
    const read = run.seenBefore > 0
      ? `A source was read, and all ${run.seenBefore} of its examples were already stored.`
      : "A source was read, and it returned no new examples.";
    return {
      ...base,
      outcome: "partial",
      headline: `${read} Another source did not work.`,
      nextStep: "Open the source details to see which source failed and why. Add another page URL or upload an example if you need more.",
    };
  }
  if (ran > 0 && run.seenBefore > 0) {
    return {
      ...base,
      outcome: "nothing_new",
      headline: `Nothing new. The page was read, and all ${run.seenBefore} of its examples were already stored.`,
      nextStep: "Review the examples already stored, add another page URL, or upload an example.",
    };
  }
  if (failed > 0) {
    const platform = blocker !== null && isPlatformBlock(blocker);
    const social = (run.seeds ?? []).map(socialPlatformOf).find((found) => found !== null) ?? null;
    if (social) {
      return {
        ...base,
        outcome: "blocked",
        headline: `${social.label} did not let Meridian read this page, so nothing was stored.`,
        nextStep: `${social.label} has no connector in this release, and a key would not change that. Upload the post or paste its text instead. Meridian does not work around the block.`,
      };
    }
    return {
      ...base,
      outcome: "blocked",
      headline: platform ? "The site did not allow Meridian to read this page, so nothing was stored." : "The page could not be read, so nothing was stored.",
      nextStep: platform
        ? "Meridian respects the site's rules and does not work around them. Add a different public page, paste the text, or upload the image or video."
        : "Check the address and try again, or upload the example instead.",
    };
  }
  if (ran > 0) {
    return { ...base, outcome: "nothing_new", headline: "The source was read, and it returned no examples.", nextStep: "Try a different page or phrase, or upload an example." };
  }
  return {
    ...base,
    outcome: "nothing_ran",
    headline: "Nothing was read in this run.",
    nextStep: "Enter a public page URL, which needs no setup, or connect a search source for phrases.",
  };
}
