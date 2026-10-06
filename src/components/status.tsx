export function StatusText({
  status,
  description,
  label = "Status",
}: {
  status: string;
  description?: string;
  label?: string;
}) {
  return (
    <p>
      <span className="text-xs font-semibold uppercase tracking-widest">
        <span aria-hidden="true">{marker(status)} </span>
        <span>
          {label}: {status}
        </span>
      </span>
      {description ? <span className="mt-1 block text-sm text-muted">{description}</span> : null}
    </p>
  );
}

function marker(status: string): string {
  const key = status.toUpperCase();
  if (key.includes("FAIL") || key.includes("REJECT") || key.includes("DEAD")) return "Fail";
  if (key.includes("HEALTH") || key.includes("APPROV") || key.includes("SENT") || key.includes("CONNECTED")) return "Ok";
  if (key.includes("REVIEW") || key.includes("PAUSE") || key.includes("PROPOS") || key.includes("WARN")) return "Wait";
  return "Note";
}
