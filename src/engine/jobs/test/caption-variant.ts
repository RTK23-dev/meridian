// The master EDL of a caption-variant test (Bible 6.13). The chain fixture's presenter covers the first 3 s, and its one caption clip
// runs to the end of the video, so a band change on that clip is kept by the editor's face rule and the variant changes nothing (a
// no-op, which is not built). This master splits the captions at the presenter's end: the caption over the presenter keeps its band,
// and the caption after it is the one a band change really moves. Pure: it reads the chain fixture and changes nothing else.

import type { EditDecisionList } from "../../contracts/index.ts";
import { edlFixture } from "../../contracts/fixtures/index.ts";

/** The time the presenter ends in the chain fixture, and where the master's captions are split. */
export const CAPTION_SPLIT_MS = 3000;

export function captionVariantMaster(band: "upper" | "middle" | "lower" = "upper"): EditDecisionList {
  const master = structuredClone(edlFixture);
  master.tracks = master.tracks.map((track) =>
    track.layer === "captions"
      ? {
          layer: "captions",
          clips: [
            { clipId: "c_cap_1", startMs: 0, endMs: CAPTION_SPLIT_MS, component: "captions.karaoke", props: { band, captions: [] } },
            { clipId: "c_cap_2", startMs: CAPTION_SPLIT_MS, endMs: 24000, component: "captions.karaoke", props: { band, captions: [] } },
          ],
        }
      : track,
  );
  return master;
}
