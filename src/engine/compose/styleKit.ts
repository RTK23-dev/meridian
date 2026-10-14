// StyleKit to CSS custom properties (Bible 9.1 rule 4, section 13). The kit is injected once, on :root, and every
// component reads only these variables. Pure: the same kit gives the same CSS, byte for byte.

import { EngineError, styleKitSchema, type StyleKit } from "../contracts/index.ts";

/** Motion intensity 0 to 3 maps to a factor that components multiply their offsets and punches by. */
export const MOTION_FACTORS = [0, 0.5, 1, 1.5] as const;

/** Font family names become CSS text, so only plain names are allowed (no quotes, braces or semicolons). */
const SAFE_FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,63}$/;

export type KitVariable = readonly [name: string, value: string];

/** Validate a kit at the boundary and return it. Throws invalid_input for a kit the compiler cannot inject safely. */
export function parseStyleKit(input: unknown): StyleKit {
  const parsed = styleKitSchema.safeParse(input);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `style kit is invalid: ${parsed.error.message}`, { stage: "compose" });
  }
  const kit = parsed.data;
  for (const [role, name] of [
    ["display", kit.fonts.display],
    ["body", kit.fonts.body],
    ["captions", kit.fonts.captions],
  ] as const) {
    if (!SAFE_FONT_NAME.test(name)) {
      throw new EngineError("invalid_input", `style kit font ${role} "${name}" is not a plain family name`, {
        stage: "compose",
      });
    }
  }
  return kit;
}

/** The custom properties in a fixed order. Components rely on the names, so they are part of the contract. */
export function styleKitVariables(input: StyleKit): KitVariable[] {
  const kit = parseStyleKit(input);
  return [
    ["--kit-primary", kit.palette.primary],
    ["--kit-secondary", kit.palette.secondary],
    ["--kit-accent", kit.palette.accent],
    ["--kit-text", kit.palette.text],
    ["--kit-background", kit.palette.background],
    ["--kit-font-display", `"${kit.fonts.display}"`],
    ["--kit-font-body", `"${kit.fonts.body}"`],
    ["--kit-font-captions", `"${kit.fonts.captions}"`],
    ["--kit-caption-highlight", kit.captionStyle.highlight],
    ["--kit-caption-weight", String(kit.captionStyle.weight)],
    ["--kit-caption-case", kit.captionStyle.case === "upper" ? "uppercase" : "none"],
    ["--kit-motion", String(MOTION_FACTORS[kit.motionIntensity])],
  ];
}

/** The :root block that carries the kit. */
export function styleKitCss(input: StyleKit): string {
  const lines = styleKitVariables(input).map(([name, value]) => `  ${name}: ${value};`);
  return [":root {", ...lines, "}", ""].join("\n");
}
