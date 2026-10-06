export function StatusText({
  status,
  description,
}: {
  status: string;
  description?: string;
}) {
  return (
    <p>
      <span className="text-xs font-semibold uppercase tracking-widest">Status: {status}</span>
      {description ? <span className="mt-1 block text-sm text-muted">{description}</span> : null}
    </p>
  );
}
