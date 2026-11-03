import { AlertTriangle } from "lucide-react";
import { needsDetails } from "./form-model";

/** A failure in plain words. The raw server text stays one disclosure away, for support and for a person who wants it. */
export function FormError({ message, raw }: { message: string; raw?: string }) {
  const showDetails = raw !== undefined && needsDetails(message, raw);
  return (
    <div role="alert" className="space-y-2 rounded-sharp border border-danger/50 bg-raised p-3 text-sm text-danger">
      <p className="flex items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{message}</span>
      </p>
      {showDetails ? (
        <details className="text-fg-primary">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-fg-muted underline-offset-4 hover:underline">Details</summary>
          <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded-sharp bg-raised p-2 text-xs text-fg-primary">{raw}</pre>
        </details>
      ) : null}
    </div>
  );
}
