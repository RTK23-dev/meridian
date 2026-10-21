import { cn } from "./cn";
import { saveStateText, type SaveStatus } from "./save-status.ts";

const dots: Record<SaveStatus, string> = { idle: "", saving: "bg-fg-muted", saved: "bg-success", error: "bg-danger" };

/** The quiet note beside a step bar: "Saving", "Saved" or "Not saved, retry". A change is announced politely. */
export function SaveState({ status, className }: { status: SaveStatus; className?: string }) {
  const text = saveStateText(status);
  return <span aria-live="polite" className={cn("inline-flex items-center gap-2 text-caption text-fg-muted", status === "error" && "text-danger", className)}>
    {text ? <><span aria-hidden="true" className={cn("size-1.5 rounded-full", dots[status])} />{text}</> : null}
  </span>;
}
