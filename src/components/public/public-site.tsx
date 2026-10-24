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
    <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-4 sm:px-8">
      <Link to="/" className="inline-flex min-h-11 items-center gap-3 rounded-sm text-fg">
        <MeridianMark className="size-7" />
        <span className="font-wordmark text-lg font-semibold tracking-tight">Meridian</span>
      </Link>
      <div className="flex flex-wrap items-center gap-2 sm:gap-4">
        <nav aria-label="Public pages" className="flex flex-wrap items-center gap-1">
          {PUBLIC_NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="inline-flex min-h-11 items-center border-b-2 border-transparent px-3 font-mono text-xs uppercase tracking-[0.14em] text-fg-muted transition-colors hover:text-fg"
              activeProps={{
                className: "inline-flex min-h-11 items-center border-b-2 border-fg px-3 font-mono text-xs uppercase tracking-[0.14em] text-fg",
              }}
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
    <footer className="mx-auto w-full max-w-6xl px-5 pb-10 pt-16 text-sm text-fg-muted sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-t border-border pt-6">
        <p className="max-w-prose">Paid ads are created paused. Keys are saved encrypted on the server, and never shown again.</p>
        <a
          href={REPO_URL}
          className="inline-flex min-h-11 items-center rounded-sm font-mono text-xs uppercase tracking-[0.14em] text-fg underline underline-offset-4"
        >
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

/**
 * A public page: the header, one main landmark whose heading is the page's only h1, the page's sections, and the footer. The
 * description sits beside the heading on wide screens and under it on a phone.
 */
export function PublicPage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <>
      <PublicHeader />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-5 sm:px-8">
        <header className="grid gap-8 pb-16 pt-12 sm:pb-20 sm:pt-20 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-end lg:gap-16">
          <h1 className="font-display text-[2.5rem] font-semibold leading-[1.02] tracking-tight text-fg sm:text-6xl">{title}</h1>
          <p className="max-w-prose text-lg leading-relaxed text-fg-muted">{description}</p>
        </header>
        <div className="space-y-24 pb-8 sm:space-y-32">{children}</div>
      </main>
      <PublicFooter />
    </>
  );
}

/** One titled section of a public page, set under a hairline rule. The heading id names the region for assistive technology. */
export function PublicSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-10">
      <h2 id={id} className="border-t border-fg pt-5 font-display text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
        {title}
      </h2>
      {children}
    </section>
  );
}
