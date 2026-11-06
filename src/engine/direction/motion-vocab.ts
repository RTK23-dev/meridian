// The motion vocabulary (L5): each animation principle as words a video model acts on, per provider family, and as the code-drawn
// crew's numbers. A prompt says what moves, how it winds up, when it hits and how it settles, instead of hoping ("an animated flame").
//
// Status: no live provider run has been recorded (Bible 20.3), so every phrasing is untested: `tested: false` until a take review shows
// the arc on screen. The families are the video routes in config/routes.ts: Kling and Seedance (video.cinematic), Seedance mini and
// Wan (video.budget). "generic" is the fallback for a model the table does not name.

export const PROVIDER_FAMILIES = ["generic", "kling", "seedance", "wan"] as const;
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export const PRINCIPLES = [
  "anticipation",
  "release",
  "settle",
  "squash_stretch",
  "smears",
  "on_twos",
  "locked_camera",
  "negative_space",
  "seamless_loop",
] as const;
export type Principle = (typeof PRINCIPLES)[number];

export type Phrasing = { text: string; tested: boolean };

/** Templates take {subject}, {what} and {at} (seconds). Short, concrete, in the order the model reads time. */
const GENERIC: Record<Principle, string> = {
  anticipation: "{subject} first pulls back and compresses slightly, a clear wind-up",
  release: "then at {at} seconds {what}, fast and decisive",
  settle: "then it overshoots a little and springs back to rest, with small secondary motion that fades out",
  squash_stretch: "it squashes flat on contact and stretches along its motion when it moves fast",
  smears: "fast moves leave a short smear of the shape for a frame, no motion blur",
  on_twos: "limited animation, each drawing held for two frames, crisp poses",
  locked_camera: "static locked-off camera, no camera drift",
  negative_space: "the subject stays in the middle band with large empty space above it",
  seamless_loop: "the last frame matches the first frame exactly, a perfect seamless loop",
};

const OVERRIDES: Partial<Record<ProviderFamily, Partial<Record<Principle, string>>>> = {
  // Kling responds to explicit timing words and camera terms; keep the camera instruction first-class.
  kling: {
    release: "at the {at} second mark {what}, a sharp sudden motion",
    locked_camera: "fixed camera, tripod shot, no zoom, no pan",
  },
  // Seedance follows shot-by-shot sequencing; name the phases as a sequence.
  seedance: {
    anticipation: "beat one: {subject} winds up, compressing",
    release: "beat two, at {at} seconds: {what}",
    settle: "beat three: it rebounds once and settles still",
  },
  // Wan tends to keep motion small; ask for the size of the move.
  wan: {
    release: "at {at} seconds {what}, a large, clearly visible motion",
    settle: "then a small bounce and it comes to a complete stop",
  },
};

export function phrase(principle: Principle, family: ProviderFamily, values: { subject: string; what: string; at: number }): Phrasing {
  const template = OVERRIDES[family]?.[principle] ?? GENERIC[principle];
  const text = template
    .replace("{subject}", values.subject)
    .replace("{what}", values.what)
    .replace("{at}", values.at.toFixed(1));
  return { text, tested: false };
}

/**
 * The code-drawn crew's numbers for the same principles: the curve for each phase (compose/motion/kit.ts), the anticipation as a
 * fraction of the move taken backwards, the overshoot, and the frames each drawing is held.
 */
export const CODE_MOTION = {
  anticipation: { curve: "kit.wind", fraction: 0.18 },
  release: { curve: "kit.whip" },
  settle: { curve: "kit.land", overshoot: 0.12 },
  heavyLanding: { curve: "kit.heavy", overshoot: 0.06 },
  holdFrames: { ones: 1, twos: 2, threes: 3 },
} as const;

/** A time held to the cadence: on twos at 30 fps a drawing changes every 2 frames (15 drawings a second). */
export function onCadence(seconds: number, fps: number, hold: 1 | 2 | 3): number {
  const frame = Math.floor(seconds * fps + 1e-6);
  return (frame - (frame % hold)) / fps;
}
