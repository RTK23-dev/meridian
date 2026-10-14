// Does a generation prompt ask the model to draw text? (Bible 7.2 rule 3 and 12.1 plan: "no generation prompt contains text
// to render"). Text is always a graphics layer drawn by code, so a prompt that asks for it is a plan failure.
//
// This is a heuristic. A cue word is ignored when a negation (no, without, free of, never...) governs it: the walk back
// from the cue crosses only list words (and, or), determiners (a, the) and other cue words, so "free of text and signs"
// and "no logos or captions" are negated, while "a sign reading OPEN" is not. Its failures route to review until the gold
// set for plan:no_text_in_generation_prompts meets the accuracy target (Bible 12.4).

const NEGATIONS = new Set([
  "no",
  "not",
  "without",
  "never",
  "nothing",
  "none",
  "free",
  "avoid",
  "avoiding",
  "zero",
  "neither",
  "nor",
]);

/** Words that name rendered text, a logo or a price. Lower case. */
const TEXT_CUES = new Set([
  "text",
  "texts",
  "word",
  "words",
  "caption",
  "captions",
  "subtitle",
  "subtitles",
  "label",
  "labels",
  "sign",
  "signs",
  "logo",
  "logos",
  "headline",
  "headlines",
  "title",
  "titles",
  "lettering",
  "letters",
  "typography",
  "font",
  "fonts",
  "written",
  "writing",
  "slogan",
  "quote",
  "quotes",
  "watermark",
  "poster",
  "banner",
  "price",
  "prices",
  "spelling",
]);

/** Words the walk back may cross between a negation and a cue: list words and determiners. */
const CROSSABLE = new Set(["and", "or", "nor", "of", "any", "a", "an", "the", "some", "its", "their", "his", "her"]);

export type PromptTextFinding = {
  asksForText: boolean;
  /** The cue words or patterns that were found, in order. Empty when asksForText is false. */
  cues: string[];
};

/** True when a negation governs the token at index: walk back across list words, determiners and cue words only. */
function isNegated(tokens: readonly string[], index: number): boolean {
  for (let position = index - 1; position >= 0; position--) {
    const word = tokens[position];
    if (NEGATIONS.has(word)) {
      return true;
    }
    if (!CROSSABLE.has(word) && !TEXT_CUES.has(word)) {
      return false;
    }
  }
  return false;
}

export function promptAsksForText(prompt: string): PromptTextFinding {
  // "text-free" and "logo-free" mean without text and without logo.
  const normal = prompt.replace(/\b([A-Za-z]+)-free\b/g, "free $1");
  const cues: string[] = [];

  for (const sentence of normal.split(/[.!?;\n]+/)) {
    const tokens = sentence.toLowerCase().split(/[^a-z0-9$£€]+/).filter((token) => token.length > 0);
    const hasNegation = tokens.some((token) => NEGATIONS.has(token));

    tokens.forEach((token, index) => {
      if (!TEXT_CUES.has(token) || isNegated(tokens, index)) {
        return;
      }
      cues.push(token);
    });

    if (/[$£€]\s?\d/.test(sentence) && !hasNegation) {
      cues.push("price figure");
    }
    if (/["“‘][^"”’]{2,}["”’]/.test(sentence) && !hasNegation) {
      cues.push("quoted words");
    }
  }

  return { asksForText: cues.length > 0, cues };
}
