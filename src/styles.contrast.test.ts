import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { contrastRatio } from "./lib/meridian/a11y/contrast.ts";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const lightTokens = stylesheet.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
const darkTokens = stylesheet.match(/\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
function token(block: string, name: string): string {
  const value = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  assert.ok(value, `Stylesheet must define a literal --color-${name} token.`);
  return value;
}

const tokenPairs = [
  ["foreground/background", "fg", "bg", 4.5, lightTokens],
  ["foreground/surface", "fg", "surface", 4.5, lightTokens],
  ["muted/background", "fg-muted", "bg", 4.5, lightTokens],
  ["muted/surface", "fg-muted", "surface", 4.5, lightTokens],
  ["accent foreground/accent", "accent-fg", "accent", 4.5, lightTokens],
  ["success/success soft", "success", "success-soft", 4.5, lightTokens],
  ["warning/warning soft", "warning", "warning-soft", 4.5, lightTokens],
  ["danger/danger soft", "danger", "danger-soft", 4.5, lightTokens],
  ["info/info soft", "info", "info-soft", 4.5, lightTokens],
  ["strong border/surface", "border-strong", "surface", 3, lightTokens],
  ["dark foreground/background", "fg", "bg", 4.5, darkTokens],
  ["dark foreground/surface", "fg", "surface", 4.5, darkTokens],
  ["dark muted/background", "fg-muted", "bg", 4.5, darkTokens],
  ["dark muted/surface", "fg-muted", "surface", 4.5, darkTokens],
  ["dark accent foreground/accent", "accent-fg", "accent", 4.5, darkTokens],
  ["dark success/success soft", "success", "success-soft", 4.5, darkTokens],
  ["dark warning/warning soft", "warning", "warning-soft", 4.5, darkTokens],
  ["dark danger/danger soft", "danger", "danger-soft", 4.5, darkTokens],
  ["dark info/info soft", "info", "info-soft", 4.5, darkTokens],
  ["dark strong border/surface", "border-strong", "surface", 3, darkTokens],
] as const;

test("semantic foreground and strong-border token pairs meet contrast targets", () => {
  for (const [name, foregroundName, backgroundName, minimum, tokens] of tokenPairs) {
    const foreground = token(tokens, foregroundName);
    const background = token(tokens, backgroundName);
    assert.ok(contrastRatio(foreground, background) >= minimum, `${name} must reach ${minimum}:1 (got ${contrastRatio(foreground, background)}:1)`);
  }
});
