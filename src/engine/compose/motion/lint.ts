// The motion "unslop" check: the tells of agent-made motion (motion-kit SKILL.md and LIBRARY section 8), found in a composition's or a
// component's HTML. It reads the source, so it runs in tests and before a render with no browser.
//
//   block: a named GSAP preset chosen as a default (power1-4, back, elastic, sine...), gsap.defaults, a blur-in.
//   warn:  an even stagger (a constant step times an index), an entrance that fades in from zero opacity.
//
// The fixes: a curve chosen for the move (MotionKit.curve, MotionKit.spring), a lead with uneven reactions (MotionKit.react), text that
// cuts on (MotionKit.cut) or types on, and blur only from fast motion. A linear ease ("none") and steps(n) are not presets: constant
// motion and stepped type-on are choices.

export type MotionRule = "named_preset" | "gsap_defaults" | "blur_in" | "even_stagger" | "fade_in";
export type MotionFinding = { rule: MotionRule; severity: "block" | "warn"; line: number; excerpt: string; message: string };

const PRESET = /ease\s*:\s*["'`](power[0-4]|back|elastic|bounce|circ|expo|sine|quad|cubic|quart|quint|strong|linear|slow|rough|expoScale)[^"'`]*["'`]/g;
const DEFAULTS = /gsap\.defaults\s*\(/g;
const BLUR = /filter\s*:\s*["'`]?\s*blur\(/g;
const STAGGER_PROP = /\bstagger\s*:/g;
const EVEN_STEP = /\+\s*(?:i|index|n|idx|k)\s*\*\s*(?:\d*\.\d+|\d+\.\d*|[A-Za-z_]\w*(?:Seconds|Step|step|Gap|gap))\b/g;
const FADE_FROM = /\bfromTo\(\s*[^,]+,\s*\{[^}]*\b(?:opacity|autoAlpha)\s*:\s*0(?:\.0+)?\s*[,}]/g;

const MESSAGES: Record<MotionRule, string> = {
  named_preset: "A named GSAP preset as the ease. Choose a curve for this move: MotionKit.curve('kit.land'), a spring, or a bezier.",
  gsap_defaults: "gsap.defaults sets one curve and timing for every move. Choose per move instead.",
  blur_in: "A blur-in reads as a template. Cut it on or mask it; blur belongs to fast motion.",
  even_stagger: "An even stagger reads as a loop. Give the lead uneven reactions: MotionKit.react(i).",
  fade_in: "An entrance that fades up from nothing reads soft and late. Cut most text on; keep fades for a chosen 'becomes'.",
};

/** The script parts of an HTML document, with the line each starts on (findings point at the HTML line). */
function scripts(html: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (!m[1]!.trim()) continue;
    const start = m.index + m[0].indexOf(m[1]!);
    out.push({ text: m[1]!, line: html.slice(0, start).split("\n").length });
  }
  return out;
}

function scan(rule: MotionRule, severity: "block" | "warn", re: RegExp, script: { text: string; line: number }, out: MotionFinding[]): void {
  re.lastIndex = 0;
  for (let m = re.exec(script.text); m; m = re.exec(script.text)) {
    const line = script.line + script.text.slice(0, m.index).split("\n").length - 1;
    out.push({ rule, severity, line, excerpt: m[0].slice(0, 80), message: MESSAGES[rule] });
  }
}

/** Every motion tell in the scripts of one HTML document, in source order. */
export function motionFindings(html: string): MotionFinding[] {
  const out: MotionFinding[] = [];
  for (const script of scripts(html)) {
    scan("named_preset", "block", PRESET, script, out);
    scan("gsap_defaults", "block", DEFAULTS, script, out);
    scan("blur_in", "block", BLUR, script, out);
    scan("even_stagger", "warn", STAGGER_PROP, script, out);
    scan("even_stagger", "warn", EVEN_STEP, script, out);
    scan("fade_in", "warn", FADE_FROM, script, out);
  }
  // One finding per rule per line: a tween that blurs from 12px to 0px is one blur-in.
  const seen = new Set<string>();
  return out
    .filter((finding) => {
      const key = `${finding.rule}:${finding.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line);
}

/** True when nothing blocks. */
export function motionPasses(html: string): boolean {
  return motionFindings(html).every((finding) => finding.severity !== "block");
}
