import { createFileRoute, Navigate } from "@tanstack/react-router";
import { GROK_PROVIDERS, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { EmailAuth } from "@/components/email-auth";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) return <main id="main" className="grid min-h-screen place-items-center text-muted">Checking session…</main>;
  if (user) return <Navigate to="/" />;
  return (
    <main id="main" className="mx-auto grid min-h-screen max-w-md content-center gap-6 px-6 py-10">
      <h1 className="font-display text-4xl">Sign in</h1>
      <EmailAuth />
      <div className="flex flex-col gap-3">
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
    </main>
  );
}