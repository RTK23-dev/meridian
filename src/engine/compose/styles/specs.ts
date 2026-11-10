// The scene specs of the code-drawn styles: what a person, a chat or the planner fills in for one video, checked before anything is drawn.
// Each style module (isometric.js, paper-cut.js, line-diagram.js, stacked-chart.js) draws a spec as a pure function of time. The specs
// carry words and numbers only; every shape, colour and move is the style's own, so no reference footage, art or music enters a render
// (CLAUDE.md rule 6). Every text field is bounded so it fits its place on a 1080 x 1920 frame.

import { z } from "zod";

export const CODED_STYLES = ["isometric", "paper_cut", "line_diagram", "stacked_chart"] as const;
export type CodedStyle = (typeof CODED_STYLES)[number];

const title = z.string().trim().min(1).max(48);
const caption = z.string().trim().min(1).max(90);
const label = z.string().trim().min(1).max(22);
/** 10 to 45 seconds: a short, inside the platforms' sweet spot. */
const durationMs = z.int().min(10_000).max(45_000);

export const ISOMETRIC_ICONS = ["phone", "laptop", "tower", "cable", "server", "cloud", "house", "factory", "store", "truck", "warehouse", "bank", "sun", "panel", "battery", "satellite"] as const;

export const isometricSpecSchema = z.strictObject({
  style: z.literal("isometric"),
  title,
  /** The stages of the route, in order: 2 to 6. A packet travels from each to the next, and each label appears as it arrives. */
  stages: z.array(z.strictObject({ label, icon: z.enum(ISOMETRIC_ICONS), caption })).min(2).max(6),
  /** What travels along the route, named on the packet (optional). */
  packet: z.string().trim().min(1).max(14).optional(),
  durationMs,
});
export type IsometricSpec = z.infer<typeof isometricSpecSchema>;

export const PAPER_SCENES = ["lighthouse", "mountains", "city", "forest"] as const;
export const PAPER_TIMES = ["night", "dusk", "day"] as const;

export const paperCutSpecSchema = z.strictObject({
  style: z.literal("paper_cut"),
  title,
  scene: z.enum(PAPER_SCENES),
  time: z.enum(PAPER_TIMES),
  /** The story lines, one per beat: 2 to 6. The scene builds layer by layer, then the light finds the hero on the last beat. */
  beats: z.array(z.strictObject({ caption })).min(2).max(6),
  durationMs,
});
export type PaperCutSpec = z.infer<typeof paperCutSpecSchema>;

export const LINE_LAYOUTS = ["cycle", "flow"] as const;

export const lineDiagramSpecSchema = z.strictObject({
  style: z.literal("line_diagram"),
  title,
  /** A cycle draws the steps round a loop that closes; a flow draws them top to bottom. */
  layout: z.enum(LINE_LAYOUTS),
  steps: z.array(z.strictObject({ label, caption })).min(3).max(6),
  /** The one warm-accent line at the end, the takeaway. */
  takeaway: z.string().trim().min(1).max(60),
  durationMs,
});
export type LineDiagramSpec = z.infer<typeof lineDiagramSpecSchema>;

export const STACK_TOKENS = ["coins", "cash", "blocks"] as const;
/** The most tokens one stack may hold (the key is honest only when each stack is counted). */
export const MAX_STACK_TOKENS = 48;

export const stackedChartSpecSchema = z
  .strictObject({
    style: z.literal("stacked_chart"),
    title,
    /** The unit one token stands for, shown in the key, e.g. "$100K". */
    unit: z.string().trim().min(1).max(16),
    /** How much of `value` one token stands for, in the bars' own unit (0.1 when values are in millions and a token is $100K). */
    perToken: z.number().positive(),
    token: z.enum(STACK_TOKENS),
    /** 2 to 6 bars. `value` sets the height; `display` is the label shown above (a figure the brief states, never computed here). */
    bars: z.array(z.strictObject({ label: z.string().trim().min(1).max(12), value: z.number().positive().max(1e15), display: z.string().trim().min(1).max(12) })).min(2).max(6),
    /** Where the numbers come from. Required unless the chart says it is illustrative. */
    source: z.string().trim().min(1).max(80).nullable(),
    illustrative: z.boolean(),
    takeaway: z.string().trim().min(1).max(60),
    durationMs,
  })
  .refine((spec) => spec.illustrative || spec.source !== null, { message: "a chart of real figures names its source; otherwise mark it illustrative", path: ["source"] })
  // The key says what one token is, so every stack is counted, never scaled: each needs 1 to MAX_STACK_TOKENS whole tokens.
  .refine((spec) => spec.bars.every((bar) => { const count = Math.round(bar.value / spec.perToken); return count >= 1 && count <= MAX_STACK_TOKENS; }), {
    message: "each bar must be between 1 and 48 tokens (value divided by perToken); choose a larger perToken",
    path: ["perToken"],
  });
export type StackedChartSpec = z.infer<typeof stackedChartSpecSchema>;

export const codedStyleSpecSchema = z.union([isometricSpecSchema, paperCutSpecSchema, lineDiagramSpecSchema, stackedChartSpecSchema]);
export type CodedStyleSpec = z.infer<typeof codedStyleSpecSchema>;

/** The module file that draws each style, next to this file. */
export const STYLE_MODULES: Readonly<Record<CodedStyle, string>> = {
  isometric: "isometric.js",
  paper_cut: "paper-cut.js",
  line_diagram: "line-diagram.js",
  stacked_chart: "stacked-chart.js",
};

/** The spec's problems in plain words, or an empty list. */
export function specProblems(spec: unknown): string[] {
  const style = spec && typeof spec === "object" ? (spec as { style?: unknown }).style : undefined;
  const schema = SPEC_SCHEMAS[style as CodedStyle];
  if (schema === undefined) return [`style: one of ${CODED_STYLES.join(", ")}`];
  // Each style's own schema, so a problem names the field of that style rather than "no style matched".
  const parsed = schema.safeParse(spec);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`);
}

const SPEC_SCHEMAS: Readonly<Record<CodedStyle, z.ZodType>> = {
  isometric: isometricSpecSchema,
  paper_cut: paperCutSpecSchema,
  line_diagram: lineDiagramSpecSchema,
  stacked_chart: stackedChartSpecSchema,
};
