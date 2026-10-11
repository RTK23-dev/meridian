import type { AutosaveStatus } from "./brain-autosave";
import { savedTimeLabel } from "./brain-autosave";

/**
 * What autosave last did, in words. A saved brain shows the time. A failure shows the reason, so the person knows the
 * edit is not stored. Viewers see nothing, because they cannot save.
 */
export function AutosaveIndicator({ status, canEdit }: { status: AutosaveStatus; canEdit: boolean }) {
  if (!canEdit) return null;
  if (status.kind === "saving") return <p role="status" className="text-sm text-fg-muted">Saving…</p>;
  if (status.kind === "saved") return <p role="status" className="text-sm font-semibold">Saved at {savedTimeLabel(status.at)}</p>;
  if (status.kind === "not-saved") return <p role="alert" className="text-sm font-semibold text-danger">{status.message}</p>;
  return <p className="text-sm text-fg-muted">Changes save as you pause and when you leave a field.</p>;
}
