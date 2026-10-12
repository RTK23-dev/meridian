import { useEffect, type ReactNode } from "react";
import { useWorkspace } from "@/components/workspace";
import { documentTitle } from "@/lib/navigation/model";
import { ErrorState, ScreenSkeleton } from "@/components/ui";
import { ForbiddenPage } from "@/components/status-pages";
import { AuthShell } from "@/components/settings/auth-shell";
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

/** The signed-out front door. It uses the same split layout as sign-in, so the first screen and the sign-in screen agree. */
export function Welcome() {
  // The signed-out front door is outside the shell, so it sets its own document title.
  useEffect(() => {
    document.title = documentTitle({ page: "Welcome" });
  }, []);
  return (
    <AuthShell
      title="Sign in or create an account"
      description="Your brands, records and decisions stay inside the workspace that owns them."
    >
      <EmailAuthForm initialMode="in" />
    </AuthShell>
  );
}
