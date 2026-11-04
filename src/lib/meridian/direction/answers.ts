// The answer contracts of the viewer panel and the swipe test (prompts.ts). A model's answer is untrusted data until it parses here; a
// field outside the contract is refused (strict objects). The concept lab's contract is in concepts.ts and the script director's in
// script.ts.

import { z } from "zod";
import { RUBRIC_MAX, rubricIdSchema } from "./codex.ts";
import { verdictSchema } from "./tournament.ts";

export const viewerPanelAnswerSchema = z.strictObject({
  verdicts: z
    .array(
      z.strictObject({
        pair: z.int().nonnegative(),
        choice: verdictSchema,
        reason: z.string().max(160),
      }),
    )
    .min(1)
    .max(40),
});
export type ViewerPanelAnswer = z.infer<typeof viewerPanelAnswerSchema>;

export const swipeTestAnswerSchema = z.strictObject({
  windows: z
    .array(
      z.strictObject({
        fromMs: z.int().nonnegative(),
        toMs: z.int().positive(),
        beatId: z.string().regex(/^b[0-9]{1,2}$/),
        sees: z.string().max(160),
        openQuestion: z.string().max(160),
        risk: z.enum(["low", "medium", "high"]),
        reason: z.string().max(200),
      }),
    )
    .min(1)
    .max(40),
  scores: z.partialRecord(rubricIdSchema, z.strictObject({ score: z.int().min(0).max(RUBRIC_MAX), evidence: z.string().max(200) })),
  verdict: z.enum(["ship", "revise"]),
  fixes: z.array(z.string().min(1).max(200)).max(6),
});
export type SwipeTestAnswer = z.infer<typeof swipeTestAnswerSchema>;

/** The scores a swipe test may count: a score with empty evidence counts as 0 (framework 3.3, rule 1). */
export function evidencedScores(answer: SwipeTestAnswer): Partial<Record<z.infer<typeof rubricIdSchema>, number>> {
  const out: Partial<Record<z.infer<typeof rubricIdSchema>, number>> = {};
  for (const [id, entry] of Object.entries(answer.scores)) {
    if (!entry) continue;
    out[id as z.infer<typeof rubricIdSchema>] = entry.evidence.trim().length > 0 ? entry.score : 0;
  }
  return out;
}

/** The text of a model's answer as JSON: plain, fenced, or the outermost braces. */
export function parseJsonText(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [fenced, trimmed]) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
        } catch {
          // Fall through to the next candidate.
        }
      }
    }
  }
  return { ok: false, error: "The answer is not JSON." };
}

/** Parse a model's answer against a contract. The error names the first problem, for the one retry. */
export function parseAnswer<T>(content: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  const json = parseJsonText(content);
  if (!json.ok) return json;
  const parsed = schema.safeParse(json.value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `${issue?.path.join(".") || "answer"}: ${issue?.message ?? "does not match the contract"}` };
}
