import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui";
import { MeridianMark } from "@/components/settings/auth-shell";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { PUBLIC_NAV, REPO_URL } from "./public-model";

/**
 * The header of the public pages and the signed-out front door. The account link follows the session: sign-in when signed out, the
 * workspace when signed in. While the session loads it shows no account link, so nobody is sent to the wrong place.
 */
export function PublicHeader({ account = true }: { account?: boolean }) {
  const { user, isPending } = useCurrentUserState();
  return (
    <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
      <Link to="/" className="inline-flex min-h-11 items-center gap-3 rounded-md text-fg">
        <MeridianMark className="size-8" />
        <span className="font-wordmark text-xl font-semibold tracking-tight">Meridian</span>
      </Link>
      <div className="flex flex-wrap items-center gap-1">
        <nav aria-label="Public pages" className="flex flex-wrap items-center">
          {PUBLIC_NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-fg-muted hover:text-fg"
              activeProps={{ className: "inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-fg" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {account && !isPending ? (
          <Button asChild variant="secondary" size="sm">
            <Link to={user ? "/" : "/login"}>{user ? "Open workspace" : "Sign in"}</Link>
          </Button>
        ) : null}
      </div>
    </header>
  );
}

/** The footer of the public pages. It states the two things people ask about first, and links to the source. */
export function PublicFooter() {
  return (
    <footer className="mx-auto w-full max-w-6xl border-t border-border px-4 py-6 text-sm text-fg-muted sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>Paid ads are created paused. Keys are saved encrypted on the server.</p>
        <a href={REPO_URL} className="inline-flex min-h-11 items-center rounded-md text-fg underline underline-offset-4">
          Source on GitHub
        </a>
      </div>
    </footer>
  );
}

/** The links under the sign-in form, for a visitor who wants to read before signing in. */
export function PublicIntroLinks() {
  return (
    <p>
      New to Meridian? Read the <Link to="/product" className="font-medium text-fg underline underline-offset-4">product</Link>, the{" "}
      <Link to="/docs" className="font-medium text-fg underline underline-offset-4">docs</Link>, or the{" "}
      <Link to="/quickstart" className="font-medium text-fg underline underline-offset-4">quickstart</Link>.
    </p>
  );
}

/** A public page: the header, one main landmark with its title, the page's sections, and the footer. */
export function PublicPage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <>
      <PublicHeader />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-4xl space-y-14 px-4 py-10 sm:px-6 sm:py-14">
        <div className="space-y-4">
          <h1 className="page-title">{title}</h1>
          <p className="max-w-prose text-lg text-fg-muted">{description}</p>
        </div>
        {children}
      </main>
      <PublicFooter />
    </>
  );
}

/** One titled section of a public page. The heading id names the region for assistive technology. */
export function PublicSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-5">
      <h2 id={id} className="text-xl font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}
