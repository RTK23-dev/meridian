import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Shell } from "@/components/shell";
import { Welcome, WorkspaceReady } from "@/components/gate";
import { WorkspaceProvider } from "@/components/workspace";
import { Toaster } from "@/components/ui";
import { SignInGate } from "@/lib/auth/gates";

/**
 * Pathless layout for every signed-in screen. The sign-in gate, the shell, workspace loading and the toaster live here
 * once, so a screen file renders only its own content. Routes outside src/routes/_app (login, api, the dev design page)
 * are not gated.
 */
export const Route = createFileRoute("/_app")({ component: AppLayout });

function AppLayout() {
  return (
    <>
      <SignInGate fallback={<Welcome />}>
        <WorkspaceProvider>
          <Shell>
            <WorkspaceReady>
              <Outlet />
            </WorkspaceReady>
          </Shell>
        </WorkspaceProvider>
      </SignInGate>
      <Toaster />
    </>
  );
}
