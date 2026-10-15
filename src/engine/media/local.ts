// TESTS AND CI ONLY. This runs the media handlers in the same process, through ffmpeg on this machine. Production code
// must take MediaFunctions and MediaDetectors (interface.ts) and receive httpMediaFunctions(...) from its composition root. The
// boundary test (boundaries.test.ts) fails if any other production file imports this module.

import { cutsInProcess } from "./cuts.ts";
import { detectorsInProcess } from "./detectors.ts";
import { framesInProcess } from "./frames.ts";
import { loudnessInProcess } from "./loudness.ts";
import type { MediaDetectors, MediaFunctions } from "./interface.ts";
import { probeInProcess } from "./probe.ts";
import { timelineInProcess } from "./timeline.ts";

export const localMediaFunctions: MediaFunctions & MediaDetectors = {
  id: "local:in-process (tests and CI only)",
  probe: probeInProcess(),
  frames: framesInProcess(),
  loudness: loudnessInProcess(),
  cuts: cutsInProcess(),
  timeline: timelineInProcess(),
  ...detectorsInProcess(),
};
