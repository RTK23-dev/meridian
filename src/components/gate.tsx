import type { ReactNode } from "react";
import { GROK_PROVIDERS, signIn } from "@/lib/auth/client";
import { useWorkspace } from "@/components/workspace";
import { EmailAuth } from "@/components/email-auth";
import { ErrorState, ScreenSkeleton } from "@/components/ui";
import { ForbiddenPage } from "@/components/status-pages";

/** Waits for the workspace bootstrap. Rendered inside the shell, so the navigation stays usable while it loads or fails. */
export function WorkspaceReady({ children }: { children: ReactNode }) {
  const { data, loading, error, forbidden, reload } = useWorkspace();
  if (loading && !data) {
    return <div className="mx-auto max-w-3xl p-6"><ScreenSkeleton label="Loading workspace" shape="cards" /></div>;
  }
  if (error && !data && forbidden) return <ForbiddenPage />;
  if (error && !data) return <ErrorState message={error} onRetry={() => void reload()} />;
  return <>{children}</>;
}

export function Welcome() {
  return (
    <main id="main" className="mx-auto grid min-h-screen max-w-3xl content-center gap-8 px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-widest text-brass">Meridian</p>
      <h1 className="font-display text-5xl leading-tight text-ink">
        What should this brand make next?
      </h1>
      <p className="max-w-xl text-lg text-muted">
        An advertising desk for a brand you add. It starts empty. You write what is true,
        record what you have actually seen, and the next recommendation has to cite that record.
      </p>
      <div className="grid max-w-3xl gap-8 md:grid-cols-2">
        <EmailAuth />
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold">Or continue with</p>
          {GROK_PROVIDERS.map((provider) => (
            <button
              key={provider.providerId}
              type="button"
              onClick={() => signIn(provider.providerId, { callbackURL: "/" })}
              className="min-h-11 rounded-md border border-line bg-panel px-4 py-3 text-left font-semibold hover:border-brass"
            >
              Continue with {provider.label}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
