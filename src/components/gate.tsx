import type { ReactNode } from "react";
import { useState } from "react";
import { GROK_PROVIDERS, signIn } from "@/lib/auth/client";
import { SignInGate } from "@/lib/auth/gates";
import { EmailAuth } from "@/components/email-auth";
import { Shell } from "@/components/shell";
import { useWorkspace } from "@/components/workspace";
import { Notice, errorText } from "@/components/ui";

export function Authed({ children }: { children: ReactNode }) {
  return (
    <SignInGate fallback={<Welcome />}>
      <Shell>
        <Ready>{children}</Ready>
      </Shell>
    </SignInGate>
  );
}

function Ready({ children }: { children: ReactNode }) {
  const { data, loading, error } = useWorkspace();
  if (loading && !data) {
    return <p className="text-muted">Loading your workspace…</p>;
  }
  if (error && !data) return <Notice>{error}</Notice>;
  return <>{children}</>;
}

function Welcome() {
  return (
    <main className="mx-auto grid min-h-screen max-w-3xl content-center gap-8 px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-widest text-brass">Meridian</p>
      <h1 className="font-display text-5xl leading-tight text-ink">
        What should this brand make next?
      </h1>
      <p className="max-w-xl text-lg text-muted">
        An advertising desk for any brand you add. It starts empty. You create the workspace,
        write what is true about the brand, and later decisions have to cite that record.
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

export function useBusy() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(task: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run };
}
