// Analysis settings for reference analysis (Bible 6.2, 8.1). The numbers the Bible states are marked as such. The rest are
// initial values to be replaced by measurements (Bible 16.2). They live here, not in engine/config, because that folder belongs
// to eng-contracts; the lead should move them into thresholds.ts (see analyze/STATUS.md).

export const analyzeConfig = {
  version: "analyze@1",

  /** Sound hits are onsets above this percentile of onset strength (Bible 8.1, rehookIntervalMs and sound hits). */
  onsetPercentile: 90,
  /** Two sound hits are at least this far apart (initial). */
  onsetRefractoryMs: 100,
  /** Onset strength is the rise of the envelope over this many milliseconds (initial). */
  onsetLagMs: 20,
  /**
   * Tempo search range (Bible 8.1: BPM from the onset envelope). A peak must stand out from the mean by minPeakRatio. Among
   * lags that score at least harmonicShare of the best, the shortest is taken, so a half-tempo multiple is not reported (initial).
   */
  bpm: { min: 60, max: 200, minPeakRatio: 1.5, harmonicShare: 0.95 },

  /** Music: non-speech energy above this floor (dBFS) for more than musicShareMin of the duration (Bible 8.1: 60%). */
  musicFloorDbfs: -40,
  musicShareMin: 0.6,

  /** A silence before the payoff is a run of windows below this level (dBFS) that is longer than the minimum (Bible 8.1). */
  silenceFloorDbfs: -50,
  silenceBeforePayoffMinMs: 300,

  /** A sound hit within this many milliseconds of a spoken word is aligned to speech, not a sound effect (initial). */
  speechPaddingMs: 100,

  /** Flash: the mean brightness changes by at least this much across a cut (0 to 1, initial). */
  flashBrightnessDelta: 0.3,
  /** Whip: the motion sample at a cut is at least this high (0 to 1, initial). */
  whipMotion: 0.25,
  /** A zoom jump within this many milliseconds of a cut is a zoom transition (initial). */
  zoomCutWindowMs: 250,

  /** The window of brightness and motion read on each side of a cut (initial). */
  cutWindowMs: 500,

  /** Loudness of a silent measure: the BS.1770 absolute gate (Bible 8.1). Silence is at or below it. */
  silentLufs: -70,
} as const;
