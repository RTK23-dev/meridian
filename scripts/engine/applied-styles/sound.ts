// The sound of a code-drawn style video, synthesised here (no sample, no provider): an original bed per style and one short effect per cue
// the style module names (a tick on a label, a pop on an arrival, a whoosh on a move, a thud on a stack, a chime on the takeaway). Mono,
// 48 kHz, float samples; the renderer masters it to -14 LUFS.

import { RATE } from "../pixel-explainer/sound.ts";

export type StyleBed = "pulse" | "pad" | "pluck" | "groove";
export type StyleCue = { at: number; kind: "tick" | "pop" | "whoosh" | "thud" | "chime" | "type" };

let seed = 7;
const noise = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x7fffffff) * 2 - 1;
};

function add(buffer: Float32Array, at: number, seconds: number, gain: number, sample: (t: number) => number): void {
  const start = Math.round(at * RATE);
  const length = Math.round(seconds * RATE);
  for (let i = 0; i < length; i++) {
    const j = start + i;
    if (j < 0 || j >= buffer.length) continue;
    buffer[j] = (buffer[j] ?? 0) + sample(i / RATE) * gain;
  }
}

const sine = (f: number, t: number) => Math.sin(2 * Math.PI * f * t);
const env = (t: number, attack: number, decay: number) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

/** The chords each bed cycles through, in Hz (root, third, fifth), four bars each. */
const CHORDS: Record<StyleBed, number[][]> = {
  pulse: [[110, 138.59, 164.81], [98, 123.47, 146.83], [87.31, 110, 130.81], [98, 123.47, 146.83]],
  pad: [[130.81, 164.81, 196], [110, 130.81, 164.81], [87.31, 110, 130.81], [98, 123.47, 146.83]],
  pluck: [[146.83, 185, 220], [123.47, 146.83, 185], [110, 138.59, 164.81], [130.81, 164.81, 196]],
  groove: [[110, 130.81, 164.81], [116.54, 146.83, 174.61], [98, 116.54, 146.83], [110, 130.81, 164.81]],
};

/** The bed: a whole number of beats long, so it ends where it starts and loops with the picture. */
export function styleBed(kind: StyleBed, seconds: number): Float32Array {
  const buffer = new Float32Array(Math.round(seconds * RATE));
  const bpm = kind === "groove" ? 96 : kind === "pulse" ? 110 : 80;
  const beat = 60 / bpm;
  const chords = CHORDS[kind];
  const barS = beat * 4;
  for (let bar = 0; bar * barS < seconds; bar++) {
    const chord = chords[bar % chords.length]!;
    const at = bar * barS;
    // A soft sustained chord under everything.
    add(buffer, at, barS + 0.4, kind === "pad" ? 0.09 : 0.06, (t) => env(t, 0.6, barS) * chord.reduce((sum, f, k) => sum + sine(f * (k === 0 ? 1 : 2), t) * (k === 0 ? 0.6 : 0.3), 0));
    for (let b = 0; b < 4; b++) {
      const bt = at + b * beat;
      if (kind === "pulse") add(buffer, bt, 0.25, 0.18, (t) => env(t, 0.004, 0.06) * sine(chord[0]! / 2, t));
      if (kind === "pluck") add(buffer, bt + beat / 2, 0.5, 0.07, (t) => env(t, 0.003, 0.18) * sine(chord[(b + bar) % 3]! * 4, t));
      if (kind === "groove") {
        add(buffer, bt, 0.3, b % 2 === 0 ? 0.28 : 0, (t) => env(t, 0.003, 0.09) * sine(55 + 60 * Math.exp(-t * 30), t));
        add(buffer, bt + beat / 2, 0.08, 0.05, () => noise() * env(0.01, 0.001, 0.02));
        add(buffer, bt, 0.4, 0.06, (t) => env(t, 0.01, 0.2) * sine(chord[b % 3]! * 2, t));
      }
      if (kind === "pad" && b === 0) add(buffer, bt, beat * 2, 0.035, (t) => env(t, 0.2, 0.8) * sine(chord[2]! * 4, t));
    }
  }
  // Fade the last 300 ms into the first, so the loop has no click.
  const fade = Math.round(0.3 * RATE);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    const j = buffer.length - fade + i;
    buffer[j] = (buffer[j] ?? 0) * (1 - k) + (buffer[i] ?? 0) * k;
  }
  return buffer;
}

export function styleCue(buffer: Float32Array, cue: StyleCue): void {
  switch (cue.kind) {
    case "tick":
      add(buffer, cue.at, 0.08, 0.22, (t) => env(t, 0.001, 0.015) * sine(1900, t));
      break;
    case "type":
      add(buffer, cue.at, 0.04, 0.08, (t) => env(t, 0.001, 0.006) * noise());
      break;
    case "pop":
      add(buffer, cue.at, 0.18, 0.3, (t) => env(t, 0.002, 0.05) * sine(420 + 900 * Math.exp(-t * 40), t));
      break;
    case "whoosh":
      add(buffer, cue.at - 0.25, 0.55, 0.12, (t) => Math.sin(Math.PI * Math.min(1, t / 0.55)) * noise());
      break;
    case "thud":
      add(buffer, cue.at, 0.35, 0.45, (t) => env(t, 0.002, 0.08) * sine(70 + 50 * Math.exp(-t * 25), t));
      break;
    case "chime":
      add(buffer, cue.at, 1.6, 0.16, (t) => env(t, 0.004, 0.5) * (sine(880, t) + 0.5 * sine(1320, t) + 0.25 * sine(1760, t)));
      break;
  }
}

export function styleTrack(kind: StyleBed, seconds: number, cues: StyleCue[]): Float32Array {
  const buffer = styleBed(kind, seconds);
  for (const cue of cues) styleCue(buffer, cue);
  return buffer;
}
