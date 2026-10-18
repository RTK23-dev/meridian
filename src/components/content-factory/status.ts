import type { CardStatus } from "@/lib/meridian/content-factory/feed";

/** How a step's status reads on screen: its label and the badge colour. Shared by the board and the step details. */
export const STATUS_LABELS: Record<CardStatus, { label: string; variant: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  not_started: { label: "Not started", variant: "neutral" },
  waiting: { label: "Queued", variant: "info" },
  running: { label: "Running", variant: "info" },
  done: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
  needs_review: { label: "Needs review", variant: "warning" },
  paused: { label: "Paused", variant: "warning" },
};
