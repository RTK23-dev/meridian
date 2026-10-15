// The readings port of analyze_reference (reference.ts, step 7), built from the picture measures: the zoom jumps and the loop. One
// call to the picture function, then code. Captions are not read here: the caption reader is a vision role that is not built
// yet (analyze/STATUS.md, blocker 2), so captions stay null and the grammar's captions field is unknown. Shake and speed ramps
// have no measurement yet (blocker 3), so the zoom reading carries them as null. An unmeasured reading never becomes a value.

import type { PictureClient } from "../media/index.ts";
import type { GrammarReadings, ReadingsScope } from "./reference.ts";
import { loopOf, zoomJumps } from "./zoom.ts";

/** The readings of one reference from the picture function. A failed call throws (a provider error): the stage fails, it does not guess. */
export function pictureReadings(
  picture: PictureClient,
): (scope: ReadingsScope) => Promise<GrammarReadings> {
  return async (scope) => {
    const measured = await picture({ source: scope.source, cutsMs: scope.cutsMs });
    const jumps = zoomJumps(measured.pairs);
    return {
      captions: null,
      zoom: jumps === null ? null : { jumps, shake: null, speedRamps: null },
      loop: loopOf(measured.loopDistance),
    };
  };
}
