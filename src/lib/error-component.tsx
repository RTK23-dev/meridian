import type { ErrorComponentProps } from "@tanstack/react-router";
import { ErrorState } from "@/components/ui";

const FALLBACK_MESSAGE = "An unexpected error occurred. Try again.";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return FALLBACK_MESSAGE;
}

/**
 * Route-level error boundary. It renders inside the shell, so navigation stays available, and Try again re-renders the
 * route that failed.
 */
export function AppErrorComponent({ error, reset }: ErrorComponentProps) {
  return (
    <section className="mx-auto max-w-2xl">
      <ErrorState message={errorMessage(error)} onRetry={reset} />
    </section>
  );
}
