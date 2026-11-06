// The sound of a directed 8-bit film, synthesised here (no sample, no provider): an original chiptune bed at 120 bpm (square bass,
// triangle arpeggio, noise hats, a kick that drops in on the hook's moment) and one sound effect per cue of direction/compile.ts sfxCues
// (L4, L11). The bed is a whole number of bars, so it loops with the picture. Mono, 48 kHz, float samples.

import { writeFileSync } from "node:fs";
import type { DirectedFilm } from "../../../src/engine/direction/film.ts";
import type { SfxCue } from "../../../src/engine/direction/compile.ts";

export const RATE = 48000;
const BPM = 120;
const BEAT = 60 / BPM;

const square = (phase: number, duty = 0.5) => ((phase % 1) < duty ? 1 : -1);
const triangle = (phase: number) => 1 - 4 * Math.abs((phase % 1) - 0.5);
let noiseSeed = 1;
const noise = () => {
  noiseSeed = (noiseSeed * 1103515245 + 12345) & 0x7fffffff;
  return (noiseSeed / 0x7fffffff) * 2 - 1;
};

function add(buffer: Float32Array, at: number, samples: (i: number, t: number) => number, seconds: number, gain: number): void {
  const start = Math.round(at * RATE);
  const length = Math.round(seconds * RATE);
  for (let i = 0; i < length; i++) {
    const j = start + i;
    if (j < 0 || j >= buffer.length) continue;
    buffer[j] = (buffer[j] ?? 0) + samples(i, i / RATE) * gain;
  }
}

const NOTE = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
// A minor: Am F C G, two bars each.
const CHORDS: number[][] = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];

/** The music bed: `bars` bars at 120 bpm. The kick waits for `dropAt` seconds (the hook's moment). */
export function bed(seconds: number, dropAt: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  const bars = Math.round(seconds / (4 * BEAT));
  for (let bar = 0; bar < bars; bar++) {
    const chord = CHORDS[Math.floor(bar / 2) % CHORDS.length] ?? CHORDS[0]!;
    const barAt = bar * 4 * BEAT;
    for (let e = 0; e < 8; e++) {
      const at = barAt + (e * BEAT) / 2;
      const root = NOTE((chord[0] ?? 57) - 24 + (e === 6 ? 12 : 0));
      add(out, at, (i, t) => square(root * t, 0.25) * Math.exp(-t * 7), BEAT / 2, 0.11);
      if (e % 2 === 1) add(out, at, (i, t) => noise() * Math.exp(-t * 90), 0.05, 0.05);
    }
    for (let s = 0; s < 16; s++) {
      const at = barAt + (s * BEAT) / 4;
      const tone = NOTE((chord[s % 3] ?? 57) + 12 + (s >= 8 && bar % 2 === 1 ? 12 : 0));
      add(out, at, (i, t) => triangle(tone * t) * Math.exp(-t * 14), BEAT / 4, 0.045);
    }
    for (let b = 0; b < 4; b++) {
      const at = barAt + b * BEAT;
      if (at + 1e-6 < dropAt) continue;
      if (b % 2 === 0) add(out, at, (i, t) => Math.sin(2 * Math.PI * (45 * t + 40 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 9), 0.25, 0.42);
      else add(out, at, (i, t) => (noise() * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-t * 22), 0.14, 0.13);
    }
  }
  return out;
}

/** One sound effect, written into the buffer at its time. */
export function sfx(buffer: Float32Array, cue: SfxCue): void {
  const at = cue.atMs / 1000;
  switch (cue.kind) {
    case "zap":
      add(buffer, at, (i, t) => square((1400 * t - 2400 * t * t) * 1) * Math.exp(-t * 9) + noise() * 0.3 * Math.exp(-t * 30), 0.32, 0.22);
      break;
    case "pop":
      add(buffer, at, (i, t) => Math.sin(2 * Math.PI * (700 * t - 1500 * t * t)) * Math.exp(-t * 28), 0.12, 0.4);
      break;
    case "tick":
      add(buffer, at, (i, t) => square(2100 * t) * Math.exp(-t * 260), 0.02, 0.08);
      break;
    case "thud":
      add(buffer, at, (i, t) => Math.sin(2 * Math.PI * (120 * t - 120 * t * t)) * Math.exp(-t * 16), 0.18, 0.5);
      break;
    case "whoosh":
      add(buffer, at - 0.25, (i, t) => noise() * Math.sin(Math.PI * Math.min(1, t / 0.45)) * 0.9, 0.45, 0.16);
      break;
    case "click":
      add(buffer, at, (i, t) => square(1500 * t) * Math.exp(-t * 120), 0.04, 0.2);
      break;
    case "chime":
      add(buffer, at, (i, t) => (Math.sin(2 * Math.PI * 1318.5 * t) + Math.sin(2 * Math.PI * 1975.5 * t) * 0.6) * Math.exp(-t * 6), 0.6, 0.12);
      break;
    case "boom":
      add(buffer, at, (i, t) => Math.sin(2 * Math.PI * (70 * t - 40 * t * t)) * Math.exp(-t * 5) + noise() * 0.4 * Math.exp(-t * 18), 0.7, 0.45);
      break;
    case "beep":
      for (let k = 0; k < 3; k++) add(buffer, at + k * 0.16, (i, t) => square(1000 * t) * (t < 0.1 ? 1 : 0), 0.1, 0.12);
      break;
    case "blip":
      add(buffer, at, (i, t) => square(880 * t, 0.25) * Math.exp(-t * 40), 0.06, 0.06);
      break;
    default:
      break;
  }
}

/** The film's whole track: the bed plus every cue, kept under full scale. Loudness is set later by ffmpeg (two-pass loudnorm). */
export function filmTrack(film: DirectedFilm, cues: SfxCue[]): Float32Array {
  const first = film.shots[0];
  const dropAt = first ? (first.startMs + first.oneMoment.hitAtMs) / 1000 : 0;
  const out = bed(film.durationMs / 1000, dropAt);
  for (const cue of cues) sfx(out, cue);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * (0.95 / peak);
  return out;
}

export function writeWav(path: string, samples: Float32Array): void {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] ?? 0)) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}
