import type { KeyboardEvent } from "react";
import { Button, Kbd } from "@/components/ui";

export type CandidateRow = { id: string; name: string; website: string; kind: string };

type CandidatesProps = {
  candidates: readonly CandidateRow[];
  canEdit: boolean;
  pendingIds: string[];
  onDecide: (id: string, action: "confirm" | "reject") => void;
};

/**
 * Unconfirmed competitors. Focus a row, then press A to accept or R to reject. The keys act only when the row itself has
 * focus, so typing in another field is never intercepted. Each shortcut is also a visible button with a key hint.
 */
export function CompetitorCandidates({ candidates, canEdit, pendingIds, onDecide }: CandidatesProps) {
  return <div className="space-y-3">
    <ul className="space-y-2">
      {candidates.map((item) => {
        const busy = pendingIds.includes(item.id);
        const handleKey = (event: KeyboardEvent<HTMLLIElement>) => {
          if (!canEdit || busy || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
          const key = event.key.toLowerCase();
          if (key === "a") {
            event.preventDefault();
            onDecide(item.id, "confirm");
          } else if (key === "r") {
            event.preventDefault();
            onDecide(item.id, "reject");
          }
        };
        return <li
          key={item.id}
          tabIndex={canEdit ? 0 : undefined}
          aria-keyshortcuts={canEdit ? "A R" : undefined}
          onKeyDown={handleKey}
          className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Candidate</span>
          <span className="font-semibold">{item.name}</span>
          <span className="text-sm text-fg-muted">· {item.kind}{item.website ? ` · ${item.website}` : ""}</span>
          {canEdit ? <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => onDecide(item.id, "confirm")}>Accept <Kbd>A</Kbd></Button>
            <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={() => onDecide(item.id, "reject")}>Reject <Kbd>R</Kbd></Button>
          </div> : null}
        </li>;
      })}
    </ul>
    {canEdit && candidates.length ? <p className="text-xs text-fg-muted">Select a candidate row, then press A to accept or R to reject. Discovery never marks a competitor confirmed on its own.</p> : null}
  </div>;
}
