import type { ReactNode } from "react";
import { useState } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { GROK_PROVIDERS, signIn } from "@/lib/auth/client";
import { SignInGate } from "@/lib/auth/gates";
import { EmailAuth } from "@/components/email-auth";
import { Shell } from "@/components/shell";
import { useWorkspace } from "@/components/workspace";
import { ErrorState, Skeleton, errorText, toast } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";

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
  const { data, loading, error, reload } = useWorkspace();
  if (loading && !data) {
    return <div role="status" aria-label="Loading workspace" className="mx-auto max-w-3xl space-y-3 p-6"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  }
  if (error && !data) return <ErrorState message={error} onRetry={() => void reload()} />;
  return <>{children}</>;
}

function Welcome() {
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

export function useBusy(invalidate: readonly QueryKey[] = []) {
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { user } = useCurrentUserState();
  const mutation = useMutation({
    mutationFn: (task: () => Promise<void>) => task(),
    onSuccess: async () => {
      await Promise.all(invalidate.map((key) => queryClient.invalidateQueries({ queryKey: userScopedQueryKey(user?.id, key) })));
    },
    onError: (caught) => toast.error(errorText(caught)),
  });
  async function run(task: () => Promise<void>) {
    setError(null);
    try {
      await mutation.mutateAsync(task);
    } catch (caught) {
      setError(errorText(caught));
    }
  }
  return { pending: mutation.isPending, error, run };
}
