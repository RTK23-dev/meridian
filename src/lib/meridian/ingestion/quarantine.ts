const DIRECTIVE =
  /^\s*(ignore\b.*\b(instruction|prompt)s?\b|you are now\b|system\s*:|developer\s*:|<\/?system>|do not follow the (system|developer))/i;

/** Drop lines that try to override instructions. The rest stays untrusted data. */
export function quarantineExternalText(raw: string): { text: string; droppedLines: number } {
  let droppedLines = 0;
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (DIRECTIVE.test(line)) {
      droppedLines += 1;
      continue;
    }
    kept.push(line.replaceAll("\u0000", ""));
  }
  return { text: kept.join("\n").trim(), droppedLines };
}
