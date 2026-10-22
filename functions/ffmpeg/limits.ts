// Infrastructure limits for the media functions (Bible 15.2: stateless, cold-start budget 3 s). These bound memory,
// time and response size. They are not tuned values. Initial values, to be reviewed when the functions are deployed.

export const FFMPEG_LIMITS = {
  /** Largest media the functions accept, in bytes. A 60 s reel is far below this. */
  maxInputBytes: 150 * 1024 * 1024,
  /** Largest media accepted inline (base64 over HTTP). Larger media must be passed by URL. */
  maxInlineBytes: 4 * 1024 * 1024,
  /** Largest HTTP request body: inline media as base64, plus JSON overhead. */
  maxRequestBodyBytes: Math.ceil((4 * 1024 * 1024 * 4) / 3) + 64 * 1024,
  /** Largest total PNG output of one frames call. */
  maxFramesOutputBytes: 32 * 1024 * 1024,
  /** Largest single PNG the tool may write. */
  maxFramePngBytes: 8 * 1024 * 1024,
  /** Largest stdout captured from one tool run. The timeline's PCM at 8 kHz mono is about 16 kB per second. */
  maxToolStdoutBytes: 4 * 1024 * 1024,
  /** Longest media the timeline measures (Bible 6.2: references run to 90 s; the cap leaves room). */
  maxTimelineMs: 240_000,
  /** Longest media the picture measures. The thumbnails of a longer picture would not fit the response. */
  maxPictureMs: 240_000,
  /**
   * Longest media the detectors measure (black and frozen frames, flicker, motion, silence). Per-frame series are one
   * value per frame, so the cap bounds the stderr that one pass returns (about 80 bytes a frame, under the stdout limit).
   */
  maxDetectMs: 240_000,
  /** Time allowed to fetch the input from a URL. */
  urlFetchTimeoutMs: 60_000,
  /** Time allowed for one tool run. The caller's transport timeout must be longer (see src/engine/media/config.ts). */
  toolTimeoutMs: {
    probe: 30_000,
    frames: 60_000,
    loudness: 120_000,
    cuts: 120_000,
    timeline: 90_000,
    picture: 90_000,
    black: 90_000,
    flicker: 90_000,
    motion: 90_000,
    silence: 60_000,
    splice: 300_000,
    version: 10_000,
  },
  /** Characters of tool stderr kept in an error message. */
  stderrTailChars: 400,
} as const;
