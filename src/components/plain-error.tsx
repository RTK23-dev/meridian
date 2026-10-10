import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorState } from "@/components/ui";
import { plainError } from "@/lib/copy";

/**
 * A failure in plain words. The sentence is shown first and the raw server text sits one Details disclosure away. When there
 * is no raw text, the sentence stands alone.
 */
export function PlainErrorNotice({ error }: { error: unknown }) {
  const { message, raw } = plainError(error);
  return <PlainErrorMessage message={message} raw={raw} />;
}

/** A screen-level failure: a plain sentence, the retry control, and the raw text under Details. */
export function PlainErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { message, raw } = plainError(error);
  return <ErrorState message={message} detail={raw} onRetry={onRetry} />;
}

export function PlainErrorMessage({ message, raw }: { message: string; raw: string }) {
  return (
    <div role="alert" className="space-y-2 text-sm text-danger">
      <p className="flex items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{message}</span>
      </p>
      {raw ? (
        <details className="text-fg">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-fg-muted underline-offset-4 hover:underline">Details</summary>
          <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 text-xs text-fg">{raw}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** A stored code or identifier that the main surface leaves out. It sits under a Details disclosure, for support and for a person who wants it. */
export function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="text-xs text-fg-muted">
      <summary className="inline-flex min-h-11 cursor-pointer items-center underline-offset-4 hover:underline">Details</summary>
      <div className="mt-1 break-all font-mono text-fg">{children}</div>
    </details>
  );
}
