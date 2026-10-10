import { useEffect, type ReactNode } from "react";
import { useWorkspace } from "@/components/workspace";
import { documentTitle } from "@/lib/navigation/model";
import { ErrorState, ScreenSkeleton } from "@/components/ui";
import { ForbiddenPage } from "@/components/status-pages";
import { MeridianMark, ProviderSignIn } from "@/components/settings/auth-shell";
import { EmailAuthForm } from "@/components/settings/email-auth-form";

/** Waits for the workspace bootstrap. Rendered inside the shell, so the navigation stays usable while it loads or fails. */
export function WorkspaceReady({ children }: { children: ReactNode }) {
  const { data, loading, error, forbidden, reload } = useWorkspace();
  if (loading && !data) {
    return <div className="mx-auto max-w-3xl p-6"><ScreenSkeleton label="Loading workspace" shape="cards" /></div>;
  }
  if (error && !data && forbidden) return <ForbiddenPage />;
  if (error && !data) return <ErrorState message={error.message} detail={error.raw} onRetry={() => void reload()} />;
  return <>{children}</>;
}

/** The signed-out front door. The copy says what the product does and does not do, and the sign-in forms sit beside it. */
export function Welcome() {
  // The signed-out front door is outside the shell, so it sets its own document title.
  useEffect(() => {
    document.title = documentTitle({ page: "Welcome" });
  }, []);
  return (
    <main id="main" tabIndex={-1} className="mx-auto grid min-h-screen w-full max-w-4xl content-center gap-10 px-4 py-12 sm:px-6">
      <div className="flex items-center gap-3">
        <MeridianMark />
        <span className="font-display text-xl font-semibold tracking-tight text-fg">Meridian</span>
      </div>
      <div className="max-w-2xl space-y-4">
        <p className="eyebrow">An advertising desk</p>
        <h1 className="font-display text-4xl leading-tight text-fg sm:text-5xl">What should this brand make next?</h1>
        <p className="text-lg text-fg-muted">
          You add a brand, and it starts empty. You write what is true and record what you have actually seen.
          The next recommendation has to cite that record.
        </p>
      </div>
      <div className="grid gap-6 md:grid-cols-2 md:gap-8">
        <section aria-labelledby="welcome-email-title" className="space-y-5 rounded-lg border border-border bg-surface p-6 shadow-sm">
          <h2 id="welcome-email-title" className="text-section font-semibold text-fg">Sign in or create an account</h2>
          <EmailAuthForm />
        </section>
        <section aria-labelledby="welcome-provider-title" className="space-y-5 rounded-lg border border-border bg-surface p-6 shadow-sm">
          <h2 id="welcome-provider-title" className="text-section font-semibold text-fg">Use a provider</h2>
          <ProviderSignIn heading="Continue with" />
        </section>
      </div>
    </main>
  );
}
