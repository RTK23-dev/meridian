import type { ReactNode } from "react";
import { Button } from "@/components/ui";
import { useState } from "react";
import { SIGN_IN_PROVIDERS, signIn, useSignInOptions } from "@/lib/auth/client";

/** The Meridian mark. It uses the same geometry as the favicon, drawn with theme tokens so it reads in light and dark. */
export function MeridianMark({ className = "size-9" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={className} focusable="false">
      <rect width="32" height="32" rx="7" fill="var(--color-fg)" />
      <circle cx="16" cy="16" r="10" fill="var(--color-bg)" />
      <rect x="14.5" y="6" width="3" height="20" fill="var(--color-accent)" />
      <circle cx="16" cy="16" r="2.4" fill="var(--color-success)" />
    </svg>
  );
}

/** A centred sign-in layout: the mark, a page title, a card for the form, and an optional footer. */
export function AuthShell({ title, description, children, footer }: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main id="main" tabIndex={-1} className="mx-auto grid min-h-screen w-full max-w-md content-center gap-6 px-4 py-10 sm:px-6">
      <div className="flex items-center gap-3">
        <MeridianMark />
        <span className="font-display text-xl font-semibold tracking-tight text-fg">Meridian</span>
      </div>
      <div className="space-y-2">
        <h1 className="font-display text-4xl leading-tight text-fg">{title}</h1>
        {description ? <p className="text-fg-muted">{description}</p> : null}
      </div>
      <div className="space-y-6 rounded-lg border border-border bg-surface p-6 shadow-sm">{children}</div>
      {footer ? <div className="text-sm text-fg-muted">{footer}</div> : null}
    </main>
  );
}

/** Sign-in with the configured providers. Each button starts the provider's own flow and returns to the workspace. */
export function ProviderSignIn({ heading = "Or continue with" }: { heading?: string }) {
  const { loaded, options } = useSignInOptions();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-fg">{heading}</p>
      <div className="grid gap-3">
        {SIGN_IN_PROVIDERS.map((provider) => (
          <Button
            key={provider.id}
            type="button"
            variant="secondary"
            size="lg"
            className="w-full justify-start"
            disabled={!loaded || !options[provider.id]}
            onClick={() => {
              setError(null);
              signIn(provider.id, { callbackURL: "/" }).catch((err: unknown) => setError(err instanceof Error ? err.message : "Sign-in failed"));
            }}
          >
            Continue with {provider.label}
          </Button>
        ))}
      </div>
      {loaded && SIGN_IN_PROVIDERS.some((provider) => !options[provider.id]) ? (
        <p className="text-sm text-fg-muted">Google sign-in is not set up on this deployment. Use email and password.</p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
