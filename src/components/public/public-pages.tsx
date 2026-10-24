import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui";
import { PublicPage, PublicSection } from "./public-site";
import { Commitments, FactoryRail, TwoLanes } from "./public-diagram";
import { CONCEPTS, QUICKSTART, REPO_DOCS, ROLES, repoDocUrl } from "./public-model";

export function ProductPage() {
  return (
    <PublicPage
      title="Creatives made from evidence, reviewed before they go out"
      description="Meridian keeps the facts a brand must not contradict, finds opportunities in evidence it can cite, makes the creatives, and learns from what was measured. Each stage is a screen, and each screen says what it has and what it is missing."
    >
      <PublicSection id="loop-title" title="The loop">
        <p className="max-w-prose text-lg leading-relaxed text-fg-muted">
          The Factory runs these stages in order. A run stops at any stage that needs a person, and the stage says why.
        </p>
        <FactoryRail />
      </PublicSection>

      <PublicSection id="two-ways-title" title="Two ways in, one core">
        <TwoLanes />
      </PublicSection>

      <PublicSection id="commitments-title" title="What Meridian does not do">
        <Commitments />
      </PublicSection>

      <PublicSection id="roles-title" title="Roles">
        {/* A scroll region a keyboard user can reach, named by its heading, so a narrow screen can still read the table. */}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-labelledby="roles-title">
          <table className="w-full min-w-[28rem] border-collapse text-left">
            <caption className="sr-only">Roles in a workspace and what each one can do</caption>
            <thead>
              <tr className="border-b border-border font-mono text-xs uppercase tracking-[0.14em] text-fg-muted">
                <th scope="col" className="py-3 pr-6 font-medium">Role</th>
                <th scope="col" className="py-3 font-medium">Can</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((role) => (
                <tr key={role.label} className="border-b border-border align-top">
                  <th scope="row" className="py-5 pr-6 font-display text-lg font-semibold text-fg">{role.label}</th>
                  <td className="py-5 text-fg-muted">{role.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PublicSection>

      <div className="flex flex-wrap gap-3 border-t border-border pt-10">
        <Button asChild>
          <Link to="/quickstart">Start the quickstart</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link to="/docs">Read the docs</Link>
        </Button>
      </div>
    </PublicPage>
  );
}

export function DocsPage() {
  return (
    <PublicPage
      title="Docs"
      description="What the words in the product mean, how a deployment runs, and where the full reference lives in the repository."
    >
      <PublicSection id="concepts-title" title="Concepts">
        <dl className="divide-y divide-border border-y border-border">
          {CONCEPTS.map((concept) => (
            <div key={concept.term} className="grid gap-2 py-6 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-8">
              <dt className="font-display text-lg font-semibold text-fg">{concept.term}</dt>
              <dd className="max-w-prose text-fg-muted">{concept.definition}</dd>
            </div>
          ))}
        </dl>
      </PublicSection>

      <PublicSection id="running-title" title="Running a deployment">
        <div className="grid gap-8 md:grid-cols-3">
          <p className="space-y-3 text-fg-muted">
            <span className="block font-mono text-xs uppercase tracking-[0.14em] text-fg">A local trial</span>
            Needs Node.js 22 and no database server. It keeps its database in <code className="font-mono text-sm text-fg">.data/pglite</code>,
            and its queued jobs run inside the dev server. Periodic work, such as scheduled discovery and performance syncs, needs the
            scheduler and a database URL.
          </p>
          <p className="space-y-3 text-fg-muted">
            <span className="block font-mono text-xs uppercase tracking-[0.14em] text-fg">A production deployment</span>
            Needs PostgreSQL 16 and a database URL. Production refuses to start without one. It also needs the worker, which runs queued
            jobs, and the scheduler, which starts periodic work.
          </p>
          <p className="space-y-3 text-fg-muted">
            <span className="block font-mono text-xs uppercase tracking-[0.14em] text-fg">Provider keys</span>
            Are saved in Settings, then General, by an admin. They are stored encrypted and never shown again. Which keys exist, and which
            stay off until you opt in, is listed in the repository.
          </p>
        </div>
      </PublicSection>

      <PublicSection id="reference-title" title="Reference in the repository">
        <ul className="divide-y divide-border border-y border-border">
          {REPO_DOCS.map((doc) => (
            <li key={doc.path}>
              <a
                href={repoDocUrl(doc.path)}
                className="group flex min-h-16 items-center justify-between gap-6 py-5 text-fg"
              >
                <span className="space-y-1">
                  <span className="block font-display text-lg font-semibold underline underline-offset-4">{doc.label}</span>
                  <span className="block text-sm text-fg-muted">{doc.what}</span>
                </span>
                <span aria-hidden="true" className="font-mono text-lg text-fg-muted transition-transform group-hover:translate-x-1 motion-reduce:transition-none">
                  →
                </span>
              </a>
            </li>
          ))}
        </ul>
      </PublicSection>
    </PublicPage>
  );
}

export function QuickstartPage() {
  return (
    <PublicPage
      title="Quickstart"
      description="Run Meridian on your own machine in a few minutes. The first screen to complete is the brand brain."
    >
      <PublicSection id="steps-title" title="The first run">
        <ol className="divide-y divide-border border-y border-border">
          {QUICKSTART.map((step, index) => (
            <li key={step.id} className="grid grid-cols-[minmax(0,1fr)] gap-4 py-8 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-8">
              <span aria-hidden="true" className="font-mono text-sm text-fg-muted">{String(index + 1).padStart(2, "0")}</span>
              <div className="min-w-0 space-y-3">
                <h3 className="font-display text-xl font-semibold text-fg">{step.title}</h3>
                <p className="max-w-prose text-fg-muted">{step.body}</p>
                {step.command ? (
                  // Focusable, so a keyboard user can scroll a command wider than the phone screen.
                  <pre tabIndex={0} className="overflow-x-auto border border-border bg-surface p-4 text-sm text-fg">
                    <code className="font-mono">{step.command}</code>
                  </pre>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </PublicSection>

      <div className="space-y-6">
        <p className="max-w-prose text-lg leading-relaxed text-fg-muted">
          When something is missing, the screen where the work happens names it and the step that fixes it. The full setup is in{" "}
          <a href={repoDocUrl("docs/SETUP.md")} className="font-medium text-fg underline underline-offset-4">the setup guide</a>.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link to="/login">Sign in</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/product">Read about the product</Link>
          </Button>
        </div>
      </div>
    </PublicPage>
  );
}
