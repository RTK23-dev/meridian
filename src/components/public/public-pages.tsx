import { Link } from "@tanstack/react-router";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { PublicPage, PublicSection } from "./public-site";
import {
  COMMITMENTS,
  CONCEPTS,
  QUICKSTART,
  REPO_DOCS,
  ROLES,
  TWO_WAYS,
  WORKFLOW,
  repoDocUrl,
} from "./public-model";

export function ProductPage() {
  return (
    <PublicPage
      title="Creatives made from evidence, reviewed before they go out"
      description="Meridian keeps the facts a brand must not contradict, finds opportunities in evidence it can cite, makes the creatives, and learns from what was measured. Each step is a screen, and each screen says what it has and what it is missing."
    >
      <PublicSection id="workflow-title" title="The workflow">
        <ol className="grid gap-3 sm:grid-cols-2">
          {WORKFLOW.map((step, index) => (
            <li key={step.id} className="flex gap-4 rounded-lg border border-border bg-surface p-4">
              <span aria-hidden="true" className="font-mono text-sm text-fg-muted">{String(index + 1).padStart(2, "0")}</span>
              <div className="space-y-1">
                <h3 className="font-semibold text-fg">{step.label}</h3>
                <p className="text-sm text-fg-muted">{step.what}</p>
              </div>
            </li>
          ))}
        </ol>
      </PublicSection>

      <PublicSection id="two-ways-title" title="Two ways to create">
        <div className="grid gap-4 md:grid-cols-2">
          {TWO_WAYS.map((way) => (
            <Card key={way.id}>
              <CardHeader>
                <CardTitle>{way.label}</CardTitle>
                <CardDescription>{way.start}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-fg-muted">{way.path}</p>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="max-w-prose text-fg-muted">
          Both use the same brands, evidence, plans, assets, runs, reviews, publishing records, measurements and learning.
        </p>
      </PublicSection>

      <PublicSection id="commitments-title" title="What Meridian does not do">
        <ul className="max-w-prose list-disc space-y-2 pl-5 text-fg-muted marker:text-fg-muted">
          {COMMITMENTS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </PublicSection>

      <PublicSection id="roles-title" title="Roles">
        <dl className="grid gap-3 sm:grid-cols-3">
          {ROLES.map((role) => (
            <div key={role.label} className="rounded-lg border border-border bg-surface p-4">
              <dt className="font-semibold text-fg">{role.label}</dt>
              <dd className="mt-1 text-sm text-fg-muted">{role.what}</dd>
            </div>
          ))}
        </dl>
      </PublicSection>

      <div className="flex flex-wrap gap-3">
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
        <dl className="divide-y divide-border rounded-lg border border-border bg-surface">
          {CONCEPTS.map((concept) => (
            <div key={concept.term} className="grid gap-1 p-4 sm:grid-cols-[12rem_1fr] sm:gap-4">
              <dt className="font-semibold text-fg">{concept.term}</dt>
              <dd className="text-fg-muted">{concept.definition}</dd>
            </div>
          ))}
        </dl>
      </PublicSection>

      <PublicSection id="running-title" title="Running a deployment">
        <div className="max-w-prose space-y-3 text-fg-muted">
          <p>
            <span className="font-semibold text-fg">A local trial</span> needs Node.js 22 and no database server. It keeps its
            database in <code className="font-mono text-sm text-fg">.data/pglite</code>, and its queued jobs run inside the dev server.
            Periodic work, such as scheduled discovery and performance syncs, needs the scheduler and a database URL.
          </p>
          <p>
            <span className="font-semibold text-fg">A production deployment</span> needs PostgreSQL 16 and a database URL. Production refuses
            to start without one. It also needs the worker, which runs queued jobs, and the scheduler, which starts periodic work.
          </p>
          <p>
            <span className="font-semibold text-fg">Provider keys</span> are saved in Settings, then General, by an admin. They are stored
            encrypted and never shown again. Which keys exist, and which stay off until you opt in, is listed in the repository.
          </p>
        </div>
      </PublicSection>

      <PublicSection id="reference-title" title="Reference in the repository">
        <ul className="grid gap-3 sm:grid-cols-2">
          {REPO_DOCS.map((doc) => (
            <li key={doc.path}>
              <a
                href={repoDocUrl(doc.path)}
                className="block min-h-11 rounded-lg border border-border bg-surface p-4 hover:border-border-strong"
              >
                <span className="font-semibold text-fg underline underline-offset-4">{doc.label}</span>
                <span className="mt-1 block text-sm text-fg-muted">{doc.what}</span>
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
      <ol className="space-y-6">
        {QUICKSTART.map((step, index) => (
          <li key={step.id} className="grid grid-cols-[minmax(0,1fr)] gap-3 rounded-lg border border-border bg-surface p-5 sm:grid-cols-[3rem_minmax(0,1fr)] sm:gap-5">
            <span aria-hidden="true" className="font-mono text-lg text-fg-muted">{index + 1}</span>
            <div className="min-w-0 space-y-3">
              <h2 className="text-lg font-semibold text-fg">{step.title}</h2>
              <p className="max-w-prose text-fg-muted">{step.body}</p>
              {step.command ? (
                // Focusable, so a keyboard user can scroll a command wider than the phone screen.
                <pre tabIndex={0} className="overflow-x-auto rounded-md border border-border bg-bg p-3 text-sm text-fg">
                  <code className="font-mono">{step.command}</code>
                </pre>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="max-w-prose text-fg-muted">
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
    </PublicPage>
  );
}
