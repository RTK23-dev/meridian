import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { AuthShell, ProviderSignIn } from "@/components/settings/auth-shell";
import { EmailAuthForm } from "@/components/settings/email-auth-form";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return <main id="main" className="grid min-h-screen place-items-center text-fg-muted">Checking session…</main>;
  }
  if (user) return <Navigate to="/" />;
  return (
    <AuthShell
      title="Sign in"
      description="Sign in with your email, or continue with a provider you already use."
    >
      <EmailAuthForm initialMode="in" />
      <ProviderSignIn />
    </AuthShell>
  );
}
