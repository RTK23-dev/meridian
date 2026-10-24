import { Link } from "@tanstack/react-router";
import { CircleCheck, CircleDashed, Circle } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Button, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { KeyForm, TestConnection } from "@/components/settings/setup-panel";
import { setupRows, setupStates, type SetupEngines, type SetupInput, type SetupRow, type SetupStatus } from "@/components/settings/setup-model";
import { hasRole } from "@/lib/meridian/access";
import { useDecisionEnginesQuery, useProviderSettingsQuery } from "@/lib/query/hooks";
import { guideFacts } from "@/lib/setup/facts";
import { buildGuide, currentStep, guideSummary, type GuideStep } from "@/lib/setup/guide";
import { EngineChoice } from "./engine-choice";

/** The keyed sources people usually start with. The rest sit under "More connectors". */
const PRIMARY_SOURCES: ReadonlyArray<{ id: string; what: string }> = [
  { id: "meta_ad_library", what: "Public ads from any advertiser in Meta's Ad Library. It needs a Meta access token." },
  { id: "youtube", what: "Public videos and their public statistics, through the YouTube Data API." },
  { id: "search", what: "Public pages that match a phrase, through a search API. Useful for finding pages to read." },
];

const MORE_SOURCES = ["twitter", "linkedin", "pinterest", "tiktok", "instagram", "licensed"];
const MEDIA_IDS = ["perception", "production", "hypit", "openrouter", "heygen", "anthropic", "deepgram"];
// The shared button does not shrink, so a long label would widen a phone-width column. This lets it wrap inside the column.
const ACTION = "max-w-full shrink whitespace-normal text-left";

const STATUS_LABEL: Record<SetupStatus, { text: string; className: string }> = {
  usable: { text: "Configured", className: "bg-success-soft text-success" },
  deployment_shared_default: { text: "Shared by the server", className: "bg-info-soft text-info" },
  unusable: { text: "Key cannot be used", className: "bg-danger-soft text-danger" },
  not_configured: { text: "Not set up", className: "bg-surface-2 text-fg-muted" },
};

/** This session's Check key answers, by row, and the way to record one. Every row list on the page reads the same answers. */
const SetupTests = createContext<{ tests: Record<string, { status: string }>; record: (id: string, answer: { status: string }) => void }>({
  tests: {},
  record: () => {},
});

const STATE_VALUE: Record<"yes" | "no" | "not_checked", { text: string; className: string }> = {
  yes: { text: "Yes", className: "text-success" },
  no: { text: "No", className: "text-warning" },
  not_checked: { text: "Not checked", className: "text-fg-muted" },
};

const STEP_MARK: Record<GuideStep["status"], { icon: typeof Circle; className: string; label: string }> = {
  done: { icon: CircleCheck, className: "bg-success text-accent-fg", label: "Done" },
  current: { icon: Circle, className: "bg-fg text-bg ring-4 ring-surface-2", label: "Do this now" },
  todo: { icon: Circle, className: "bg-surface-2 text-fg-muted ring-1 ring-border", label: "To do" },
  optional: { icon: CircleDashed, className: "bg-surface-2 text-fg-muted ring-1 ring-border", label: "Optional" },
  unknown: { icon: CircleDashed, className: "bg-warning-soft text-warning", label: "Could not check" },
};

/**
 * The guided setup. Each step says what it is, why it matters, and what the saved records show now. The steps run in order, and
 * the current step is the first one not done. Keys are saved on the step that needs them, through the same admin-only path as
 * Settings. Nothing here is checked against a live provider.
 */
export function SetupGuide() {
  const { data, loading } = useWorkspace();
  const organizationId = data?.active?.id ?? "";
  const providers = useProviderSettingsQuery(organizationId);
  const engines = useDecisionEnginesQuery(organizationId);
  const [testAnswers, setTestAnswers] = useState<Record<string, { status: string }>>({});
  const recordTest = (id: string, answer: { status: string }) => setTestAnswers((previous) => ({ ...previous, [id]: answer }));

  if (loading) return <p role="status" className="text-sm text-fg-muted">Loading setup...</p>;
  if (!data?.active) {
    return (
      <div className="space-y-3">
        <p className="text-fg-muted">Create a workspace first, then come back here.</p>
        <Button asChild variant="secondary" className={ACTION}><Link to="/">Back to the overview</Link></Button>
      </div>
    );
  }

  const active = data.active;
  const canAdmin = hasRole(active.role, "admin");
  const canCreate = hasRole(active.role, "member");
  const summaries = (providers.data as SetupInput["summaries"] | undefined) ?? null;
  const engineStatus = (engines.data as SetupEngines | undefined) ?? null;
  const rows = summaries && engineStatus ? setupRows({ summaries, engines: engineStatus }) : [];
  const rowById = (id: string): SetupRow | undefined => rows.find((row) => row.id === id);
  const steps = buildGuide(guideFacts({ brandCount: data.brands.length, summaries, engines: engineStatus }));
  const summary = guideSummary(steps);
  const next = currentStep(steps);
  const firstBrand = data.brands[0];
  const percent = summary.requiredTotal === 0 ? 0 : Math.round((summary.requiredDone / summary.requiredTotal) * 100);

  const keyState = (id: "jev" | "openai") => {
    const row = rowById(id);
    return { fingerprint: row?.fingerprint ?? null, removable: row?.removable ?? false };
  };

  const body = (step: GuideStep) => {
    switch (step.id) {
      case "brand":
        return <BrandAction brandCount={data.brands.length} canCreate={canCreate} firstBrandId={firstBrand?.id} firstBrandName={firstBrand?.name} />;
      case "engine":
        return engineStatus
          ? <EngineChoice organizationId={organizationId} canAdmin={canAdmin} engines={engineStatus} keys={{ jev: keyState("jev"), openai: keyState("openai") }} />
          : <p className="text-sm text-fg-muted">The engine status is loading.</p>;
      case "sources":
        return <SourcesAction rowById={rowById} loaded={summaries !== null} canAdmin={canAdmin} organizationId={organizationId} brandId={firstBrand?.id} />;
      case "media":
        return <RowList ids={MEDIA_IDS} rowById={rowById} loaded={summaries !== null} canAdmin={canAdmin} organizationId={organizationId} footnote="Skipping this is fine. You can upload images and video you already have." />;
      case "publish":
        return (
          <div className="space-y-3">
            <RowList ids={["meta_graph"]} rowById={rowById} loaded={summaries !== null} canAdmin={canAdmin} organizationId={organizationId} />
            <p className="text-sm text-fg-muted">
              Meridian creates Meta campaigns and ads with status <strong className="text-fg">paused</strong>. A paused ad does not show or spend until
              someone switches it on in Meta Ads Manager. Meridian has no button that switches it on.
              {firstBrand ? <> Connected Facebook Pages and YouTube accounts are set on <Link to={`/brands/${firstBrand.id}/accounts` as never} className="font-semibold text-accent-text underline-offset-4 hover:underline">Connected accounts</Link>.</> : null}
            </p>
          </div>
        );
      case "storage":
        return <StorageAction row={rowById("google_drive")} loaded={summaries !== null} />;
    }
  };

  return (
    <SetupTests.Provider value={{ tests: testAnswers, record: recordTest }}>
      <div className="space-y-10">
        <PageHeader
          title="Set up Meridian"
          description="Create a brand, then choose a decision engine and save its key. The other connections are on this page. Each one shows what it needs and saves it here."
          breadcrumbs={[{ label: "Overview", to: "/" }]}
        />

        <section aria-labelledby="setup-progress" className="surface-rise rounded-xl border border-border bg-surface p-5 shadow-sm md:p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <h2 id="setup-progress" className="text-xl font-semibold text-fg">{summary.requiredDone} of {summary.requiredTotal} required steps done</h2>
              <p className="text-sm text-fg-muted">{summary.headline}</p>
            </div>
            {next ? (
              <a href={`#step-${next.id}`} className="inline-flex min-h-11 max-w-full items-center rounded-md bg-accent px-4 text-center text-sm font-semibold text-accent-fg transition hover:brightness-110">
                Go to: {next.title}
              </a>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-label="Required setup steps"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="mt-5 h-2 overflow-hidden rounded-full bg-surface-2"
          >
            <div className="h-full rounded-full bg-fg transition-[width] duration-700 ease-out" style={{ width: `${percent}%` }} />
          </div>
          {!canAdmin ? <p className="mt-4 text-sm text-fg-muted">Only a workspace admin can save keys or choose the engine. Everyone can read these states.</p> : null}
        </section>

        <ol className="space-y-5">
          {steps.map((step, index) => (
            <SetupStep key={step.id} step={step} index={index} body={body(step)} />
          ))}
        </ol>

        <section aria-labelledby="setup-advanced" className="rounded-xl border border-dashed border-border p-5">
          <h2 id="setup-advanced" className="font-semibold text-fg">Every provider in one list</h2>
          <p className="mt-1 text-sm text-fg-muted">The same keys, states and reasons, with the server variables for each row, are on Settings → General.</p>
          <Button asChild variant="quiet" className="mt-3"><Link to="/settings">Open Settings</Link></Button>
        </section>
      </div>
    </SetupTests.Provider>
  );
}

function SetupStep({ step, index, body }: { step: GuideStep; index: number; body: ReactNode }) {
  const mark = STEP_MARK[step.status];
  const Icon = mark.icon;
  const isCurrent = step.status === "current";
  return (
    <li id={`step-${step.id}`} className="scroll-mt-24">
      <article
        aria-labelledby={`step-title-${step.id}`}
        className={`stagger-in rounded-xl border bg-surface p-5 shadow-sm transition duration-300 hover:shadow-md md:p-6 ${isCurrent ? "border-fg" : "border-border"}`}
        style={{ animationDelay: `${Math.min(index, 2) * 40}ms` }}
      >
        <div className="flex items-start gap-4">
          <span className={`grid size-9 shrink-0 place-items-center rounded-full ${mark.className}`} aria-hidden="true">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`step-title-${step.id}`} className="text-xl font-semibold text-fg">
                <span className="mr-2 text-fg-muted">{index + 1}.</span>{step.title}
              </h3>
              <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-fg-muted">
                {step.required ? "Required" : "Optional"} · {mark.label}
              </span>
            </div>
            <p className="text-sm text-fg">{step.what}</p>
            <p className="text-sm text-fg-muted">{step.detail}</p>
            <div className="pt-1">{body}</div>
          </div>
        </div>
      </article>
    </li>
  );
}

function BrandAction({ brandCount, canCreate, firstBrandId, firstBrandName }: { brandCount: number; canCreate: boolean; firstBrandId?: string; firstBrandName?: string }) {
  if (brandCount === 0) {
    return canCreate ? (
      <div className="space-y-2">
        <Button asChild variant="secondary" className={ACTION}><Link to="/brands/new">Create your first brand</Link></Button>
        <p className="text-sm text-fg-muted">You only need a name and what you sell. The website and the rest of the brand brain can be added later.</p>
      </div>
    ) : <p className="text-sm text-fg-muted">Only a workspace member can create a brand.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {firstBrandId ? <Button asChild variant="secondary" className={ACTION}><Link to={`/brands/${firstBrandId}/brain` as never}>Fill in {firstBrandName ?? "the brand"}&apos;s brain</Link></Button> : null}
      {canCreate ? <Button asChild variant="quiet" className={ACTION}><Link to="/brands/new">Add another brand</Link></Button> : null}
    </div>
  );
}

function SourcesAction({ rowById, loaded, canAdmin, organizationId, brandId }: { rowById: (id: string) => SetupRow | undefined; loaded: boolean; canAdmin: boolean; organizationId: string; brandId?: string }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-4">
          <p className="font-semibold text-fg">Public web pages</p>
          <p className="text-sm text-fg-muted">No key. Meridian reads a page you name and stores its text as evidence. It reads the site&apos;s robots.txt first, and it reports a bot check instead of getting past it.</p>
          {brandId ? <Button asChild variant="quiet" className={ACTION}><Link to={`/brands/${brandId}/market` as never}>Read a public page on Market</Link></Button> : null}
        </div>
        <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-4">
          <p className="font-semibold text-fg">Your own files and links</p>
          <p className="text-sm text-fg-muted">No key. Add the files and links you have the right to use: brand source material in the brand brain, and your own creatives in the Library.</p>
          {brandId ? <Button asChild variant="quiet" className={ACTION}><Link to={`/brands/${brandId}/library` as never}>Open Library</Link></Button> : null}
        </div>
      </div>
      <RowList ids={PRIMARY_SOURCES.map((source) => source.id)} rowById={rowById} loaded={loaded} canAdmin={canAdmin} organizationId={organizationId} descriptions={Object.fromEntries(PRIMARY_SOURCES.map((source) => [source.id, source.what]))} />
      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-sm font-semibold text-fg">More connectors ({MORE_SOURCES.length})</summary>
        <div className="mt-4">
          <RowList ids={MORE_SOURCES} rowById={rowById} loaded={loaded} canAdmin={canAdmin} organizationId={organizationId} />
        </div>
      </details>
    </div>
  );
}

function RowList({
  ids,
  rowById,
  loaded,
  canAdmin,
  organizationId,
  descriptions,
  footnote,
}: {
  ids: readonly string[];
  rowById: (id: string) => SetupRow | undefined;
  loaded: boolean;
  canAdmin: boolean;
  organizationId: string;
  descriptions?: Record<string, string>;
  footnote?: string;
}) {
  const { tests, record } = useContext(SetupTests);
  if (!loaded) return <p className="text-sm text-fg-muted">Loading the saved keys...</p>;
  return (
    <div className="space-y-3">
      {ids.map((id) => {
        const row = rowById(id);
        if (!row) return null;
        const status = STATUS_LABEL[row.status];
        return (
          <div key={id} className="space-y-3 rounded-lg border border-border p-4" data-row={id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <p className="font-semibold text-fg">{row.label}</p>
                {descriptions?.[id] ? <p className="text-sm text-fg-muted">{descriptions[id]}</p> : null}
                <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{row.reason}</p>
                {row.fingerprint ? <p className="font-mono text-xs text-fg-muted">Stored key ends {row.fingerprint}</p> : null}
                {row.note ? <p className="text-sm text-fg-muted">{row.note}</p> : null}
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${status.className}`}>{status.text}</span>
            </div>
            <ul className="grid gap-2 sm:grid-cols-3" aria-label={`${row.label}: setup states`}>
              {setupStates(row, tests[id] ?? null).map((reading) => (
                <li key={reading.name} className="rounded-md border border-border p-2.5">
                  <p className="text-sm font-semibold text-fg">
                    {reading.label}: <span className={STATE_VALUE[reading.value].className}>{STATE_VALUE[reading.value].text}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-fg-muted [overflow-wrap:anywhere]">{reading.detail}</p>
                </li>
              ))}
            </ul>
            {row.save.kind === "form" && !row.fingerprint ? (
              <KeyForm row={row} organizationId={organizationId} canAdmin={canAdmin} category={row.save.category} />
            ) : null}
            {row.save.kind === "form" && row.fingerprint ? (
              <details className="group rounded-md border border-border p-3">
                <summary className="cursor-pointer text-sm font-semibold text-fg underline decoration-accent underline-offset-4">Replace or remove the key</summary>
                <div className="mt-3">
                  <KeyForm row={row} organizationId={organizationId} canAdmin={canAdmin} category={row.save.category} />
                </div>
              </details>
            ) : null}
            {row.testable && canAdmin ? <TestConnection row={row} organizationId={organizationId} onAnswer={(answer) => record(id, answer)} /> : null}
          </div>
        );
      })}
      {footnote ? <p className="text-sm text-fg-muted">{footnote}</p> : null}
    </div>
  );
}

function StorageAction({ row, loaded }: { row: SetupRow | undefined; loaded: boolean }) {
  if (!loaded || !row) return <p className="text-sm text-fg-muted">Loading the storage state...</p>;
  return (
    <div className="space-y-2 rounded-lg border border-border p-4">
      <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{row.reason}</p>
      {row.save.kind === "deployment" ? (
        <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
          Set on the server, not here: {row.save.variables.map((name, index) => (
            <span key={name}>{index > 0 ? ", " : ""}<code className="font-mono text-xs text-fg">{name}</code></span>
          ))}. No key is shown on this page.
        </p>
      ) : null}
    </div>
  );
}
