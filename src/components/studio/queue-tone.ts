/** The badge variant for a publishing queue status. The table and the phone cards share it, so a status reads the same. */
export type QueueTone = "success" | "info" | "danger" | "neutral" | "warning";

/** A queued or unknown status is a warning, so anything not yet settled stands out. */
export function queueTone(status: string): QueueTone {
  if (status === "published") return "success";
  if (status === "processing") return "info";
  if (status === "failed") return "danger";
  if (status === "cancelled") return "neutral";
  return "warning";
}
