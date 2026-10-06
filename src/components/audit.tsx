export function AuditList({
  entries,
}: {
  entries: { id: string; action: string; actorName?: string; objectType?: string; createdAt: string; metadata: Record<string, string> }[];
}) {
  if (entries.length === 0) return <p className="mt-3 text-sm text-muted">No actions recorded yet.</p>;
  return (
    <ul className="mt-4 divide-y divide-line">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
          <span>{entry.actorName ? `${entry.actorName} · ` : ""}{entry.action.replaceAll(".", " · ")}{entry.objectType ? ` · ${entry.objectType}` : ""}</span>
          <span className="text-muted">
            {entry.metadata.name || entry.createdAt.slice(0, 16).replace("T", " ")}
          </span>
        </li>
      ))}
    </ul>
  );
}
