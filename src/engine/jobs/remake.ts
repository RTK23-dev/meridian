// Remakes of one shot (Video Engine Bible 5.5): the reviewer's direction for a shot, as it is stored and as it reaches the prompt of
// the new take. Pure: no database and no model call. The direction is a person's text, not a model's answer. It is kept as plain text,
// cleaned of control characters and capped in length. It is never read as a rule, and the gates still decide every take.

import { z } from "zod";
import { EngineError } from "../contracts/index.ts";

/** The longest direction a person can give for one shot. A longer one is refused, not cut (fail closed). */
export const REMAKE_DIRECTIVE_MAX_CHARS = 280;

/** The most directions one shot keeps. Each remake of the shot adds one, so this bounds the prompt. */
export const REMAKE_DIRECTIVES_MAX = 8;

/**
 * The direction as it is stored: trimmed, control characters and runs of whitespace collapsed to one space. Null when nothing is left.
 * Throws an invalid-input error above the length limit.
 */
export function remakeDirectiveOf(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const cleaned = [...text]
    .map((char) => (isControl(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length > REMAKE_DIRECTIVE_MAX_CHARS) {
    throw new EngineError("invalid_input", `a direction for a shot is at most ${REMAKE_DIRECTIVE_MAX_CHARS} characters`, { stage: "produce_shot" });
  }
  return cleaned;
}

/** A C0 control character or DEL: a character no direction should carry. */
function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

const directivesSchema = z.array(z.string().min(1).max(REMAKE_DIRECTIVE_MAX_CHARS)).max(REMAKE_DIRECTIVES_MAX);

/** The directions a produce job carries in its details. Absent means none. Anything else is refused, never guessed. */
export function directivesOf(details: Record<string, unknown>): string[] {
  const parsed = directivesSchema.safeParse(details.directives ?? []);
  if (!parsed.success) {
    throw new EngineError("invalid_input", "a produce job's directions are not a short list of texts", { stage: "produce_shot" });
  }
  return parsed.data;
}

/**
 * The prompt of a generated take with the reviewer's directions added after the rules. They sit in a labelled block, so the model reads
 * them as a request about this take. With no directions the prompt is returned unchanged.
 */
export function promptWithDirectives(prompt: string, directives: readonly string[]): string {
  if (directives.length === 0) return prompt;
  const lines = directives.map((text) => `- ${text}`).join("\n");
  return `${prompt}\n\nReviewer's direction for this take (a creative request from the person who reviews the video; the rules above still apply):\n${lines}`;
}
