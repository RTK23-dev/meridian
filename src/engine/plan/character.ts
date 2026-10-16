// The page's character sheets as the plan reads them (Bible 13, 9.2). Pure. Kept apart from sources.ts so that minimum.ts can count
// the rig without importing the component library. A rigged sheet drives character.rig only when it lists the rig's own names:
// the idle pose the rig starts in, and the closed and open mouth shapes. A sheet that lists other names (for example phoneme
// names) cannot drive the rig, so the type is not offered for the page (7.2 rule 6), rather than failing the plan later.

import type { CharacterSheet } from "../contracts/index.ts";

/** Why a character sheet cannot drive character.rig, or null when it can. */
export function rigSheetProblem(sheet: CharacterSheet): string | null {
  if (sheet.kind !== "rigged_svg") return "the page's character is not a rigged SVG sheet";
  const poses = sheet.poses ?? [];
  const visemes = sheet.visemes ?? [];
  if (!poses.includes("idle")) return "the character sheet does not list the idle pose that the rig starts in";
  if (!visemes.includes("closed") || !visemes.includes("open")) {
    return "the character sheet does not list the closed and open mouth shapes the rig needs";
  }
  return null;
}

/**
 * The page's rig: the first rigged sheet, in the order the caller gives them, that can drive character.rig. Undefined when no
 * sheet can. Intake and the plan read the same sheets, so the kit flag and the source agree.
 */
export function rigSheetOf(characters: readonly CharacterSheet[]): CharacterSheet | undefined {
  return characters.find((sheet) => rigSheetProblem(sheet) === null);
}
