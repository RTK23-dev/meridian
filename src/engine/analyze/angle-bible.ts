// The Angle Bible entries the genome role names genes by (Bible 6.2 step 5). The entries are Meridian's study framework
// (src/lib/meridian/study/bible.ts). This module is the one place the engine reads them, and it passes them to the role as input,
// so the Claude folder stays free of the study code (claude/boundaries.test.ts). Pure.

import { ANGLE_BIBLE_DIMENSIONS } from "../../lib/meridian/study/bible.ts";

/** One Angle Bible entry as the genome role sees it: its slug is the only value the role may return. */
export type AngleBibleEntryRef = {
  slug: string;
  dimension: string;
  name: string;
  definition: string;
};

/** Every entry of the Angle Bible, in dimension order. */
export function angleBibleEntries(): AngleBibleEntryRef[] {
  return ANGLE_BIBLE_DIMENSIONS.flatMap((dimension) =>
    dimension.entries.map((entry) => ({
      slug: entry.slug,
      dimension: dimension.name,
      name: entry.name,
      definition: entry.definition,
    })),
  );
}
