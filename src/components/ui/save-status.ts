export type SaveStatus = "idle" | "saving" | "saved" | "error";

/** The words for a save state. An idle form shows no note until a save starts. */
export function saveStateText(status: SaveStatus): string {
  if (status === "saving") return "Saving";
  if (status === "saved") return "Saved";
  if (status === "error") return "Not saved, retry";
  return "";
}
