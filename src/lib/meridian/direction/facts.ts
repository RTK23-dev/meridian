// Facts and limits (framework 0, 9 and 11, weak spot W12): a script may not run longer than its limit, may not name a term the brand
// forbids, and should not state a number the brief does not give. Numbers are the specific detail a model invents most easily, so every
// number in the voice and on screen is looked for in the brief, its sources and the approved claims. A number found nowhere there is a
// warning, not a block: it may be a count the picture shows ("three mugs"). A person or the claims gate decides. Pure.

import type { ScriptFinding } from "./slop.ts";
import type { DirectedScript } from "./script.ts";

const NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  fifteen: "15",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
  hundred: "100",
  thousand: "1000",
};

const TENS = new Set(["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]);
const UNITS = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]);

/**
 * The numbers a text states: digits (thousands separators dropped, decimals kept) and English number words, as digit strings. A tens word
 * followed by a unit word ("sixty one", "sixty-one") is one number.
 */
export function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    found.add(match[0].replace(/,/g, "").replace(/\.0+$/, ""));
  }
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const next = words[index + 1];
    if (TENS.has(word) && next !== undefined && UNITS.has(next)) {
      found.add(String(Number(NUMBER_WORDS[word]) + Number(NUMBER_WORDS[next])));
      index += 1;
      continue;
    }
    const digits = NUMBER_WORDS[word];
    if (digits) found.add(digits);
  }
  return found;
}

function termPattern(term: string): RegExp {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * The fact findings of a script. `facts` is everything the brief gives (its text, its sources, the approved claims); leave it out when it
 * is not known, and the number check is not run. `forbidden` are the brand's forbidden terms. `maxDurationMs` is the length limit, checked
 * against the timeline's duration.
 */
export function factFindings(
  script: DirectedScript,
  options: { durationMs: number; maxDurationMs?: number; forbidden?: readonly string[]; facts?: string },
): ScriptFinding[] {
  const findings: ScriptFinding[] = [];
  if (options.maxDurationMs !== undefined && options.durationMs > options.maxDurationMs) {
    findings.push({
      check: "max_duration",
      severity: "block",
      evidence: "sourced",
      message: `The script runs about ${(options.durationMs / 1000).toFixed(1)} s, over the limit of ${(options.maxDurationMs / 1000).toFixed(1)} s. Cut words, not pace.`,
    });
  }

  const patterns = (options.forbidden ?? []).filter((term) => term.trim().length > 0).map((term) => ({ term, pattern: termPattern(term) }));
  const known = options.facts === undefined ? null : numbersIn(options.facts);
  for (const beat of script.beats) {
    const said = [beat.voice, beat.onScreenText ?? ""].join(" ");
    for (const { term, pattern } of patterns) {
      if (pattern.test(`${said} ${beat.picture ?? ""}`)) {
        findings.push({ check: "forbidden_term", severity: "block", evidence: "sourced", beatId: beat.beatId, phrase: term, message: `Beat ${beat.beatId} names "${term}", a term the brand forbids.` });
      }
    }
    if (known) {
      const unsourced = [...numbersIn(said)].filter((number) => !known.has(number));
      if (unsourced.length > 0) {
        findings.push({
          check: "unsourced_number",
          severity: "warn",
          evidence: "sourced",
          beatId: beat.beatId,
          message: `Beat ${beat.beatId} states ${unsourced.join(", ")}, which the brief, its sources and the claims do not give. Use the brief's numbers, or show the detail instead of stating it.`,
        });
      }
    }
  }
  return findings;
}
