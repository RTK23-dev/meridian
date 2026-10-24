// The brief a Content Factory session starts with when it is made from an opportunity. It carries the idea's own stored words, trimmed and
// clipped, and adds nothing. The text is the person's brief: it is shown and kept as text, and it is never run as an instruction.

export type BriefIdea = {
  label: string;
  angle: string;
  hookType: string;
  audience: string;
  format: string;
  proofType: string;
  productName: string;
  reason: string;
  evidence: readonly { summary: string }[];
};

const FIELD_MAX = 400;
const EVIDENCE_MAX = 5;

/** A stored text as one line, at most FIELD_MAX characters. Empty when it has no words. */
function oneLine(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > FIELD_MAX ? `${text.slice(0, FIELD_MAX - 1)}…` : text;
}

/** The brief's text: the idea, then each field the idea stored, then up to EVIDENCE_MAX evidence summaries. A field that is empty is left out. */
export function briefTextOf(idea: BriefIdea): string {
  const lines = [`Idea: ${oneLine(idea.label)}`];
  const fields: Array<[string, string]> = [
    ["Angle", idea.angle],
    ["Hook", idea.hookType],
    ["Audience", idea.audience],
    ["Format", idea.format],
    ["Proof", idea.proofType],
    ["Product", idea.productName],
    ["Why this idea", idea.reason],
  ];
  for (const [name, value] of fields) {
    const text = oneLine(value);
    if (text !== "") lines.push(`${name}: ${text}`);
  }
  const evidence = idea.evidence.map((item) => oneLine(item.summary)).filter((summary) => summary !== "").slice(0, EVIDENCE_MAX);
  if (evidence.length > 0) {
    lines.push("Evidence:");
    for (const summary of evidence) lines.push(`- ${summary}`);
  }
  return lines.join("\n");
}

/** The summaries of an opportunity's stored evidence (a JSON list of {id, source, summary}). An unreadable list has none, never a guess. */
export function evidenceSummariesOf(stored: string): { summary: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const summary = (item as { summary?: unknown }).summary;
    return typeof summary === "string" ? [{ summary }] : [];
  });
}
