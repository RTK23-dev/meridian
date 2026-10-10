import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { ArrowRight } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBusy } from "@/components/gate";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogTitle, Badge, Button, Card, ErrorState, errorText, Field, Notice, PageHeader, Skeleton, TextArea, TextInput,
} from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { deleteBrand, updateBrand } from "@/lib/meridian/api";
import { brainCompleteness } from "@/lib/meridian/brain";
import type { MachineSnapshot } from "@/lib/meridian/machine";
import { useBrandQuery, useMachineQuery, useOpportunitiesQuery, useReviewsQuery } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { brandIdentitySchema, type BrandIdentity, type BrandIdentityInput } from "@/lib/meridian/schemas/brand";

export const Route = createFileRoute("/brands/$brandId/")({ component: BrandPage });

function BrandPage() {
  const { brandId } = Route.useParams();
  return <BrandHome brandId={brandId} />;
}

function BrandHome({ brandId }: { brandId: string }) {
  const detailQuery = useBrandQuery(brandId);
  const machineQuery = useMachineQuery(brandId);
  const opportunitiesQuery = useOpportunitiesQuery(brandId);
  const reviewsQuery = useReviewsQuery(brandId);
  const detail = detailQuery.data ?? null;
  const machine = machineQuery.data ?? null;
  const { reload } = useWorkspace();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const { register, handleSubmit, reset, formState: { errors, isDirty, isSubmitting } } = useForm<BrandIdentityInput, unknown, BrandIdentity>({
    resolver: zodResolver(brandIdentitySchema),
    defaultValues: { name: "", description: "", category: "", industry: "", website: "", country: "", sells: "", targetCustomers: "" },
    mode: "onBlur",
  });
  const { pending, error: saveError, run } = useBusy([qk.brand(brandId), qk.machine(brandId)]);

  useEffect(() => {
    if (!detail || isDirty) return;
    reset({ ...detail.identity, targetCustomers: detail.brain.targetCustomers });
  }, [detail, isDirty, reset]);

  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [isDirty]);

  if (detailQuery.error) return <ErrorState message={errorText(detailQuery.error)} onRetry={() => void detailQuery.refetch()} />;
  if (!detail) return <div role="status" aria-label="Loading brand" className="space-y-3"><Skeleton variant="line" /><Skeleton variant="card" /></div>;
  const known = brainCompleteness(detail.brain);
  const canEdit = hasRole(detail.identity.role, "member");
  const canDelete = hasRole(detail.identity.role, "admin");

  async function submit(values: BrandIdentity) {
    const saved = await run(async () => {
      await updateBrand({
        data: {
          brandId,
          ...values,
        },
      });
      await reload();
    });
    if (saved) reset(values);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        breadcrumbs={[{ label: "All brands", to: "/" }]}
        title={detail.identity.name}
        description={<>{known.filled} of {known.total} brand brain fields · Version {detail.version || 1}</>}
        actions={<Button asChild><Link to="/brands/$brandId/brain" params={{ brandId }}>Complete brand brain</Link></Button>}
      />

      {machine ? <NextAction brandId={brandId} snapshot={machine} filled={known.filled} /> : <Skeleton variant="card" />}
      {machine ? <Pipeline brandId={brandId} snapshot={machine} filled={known.filled} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <OpportunityChart rows={opportunitiesQuery.data?.opportunities ?? []} />
        <ReviewAgeChart rows={reviewsQuery.data?.reviews ?? []} />
      </div>

      {machine ? <MissingList brandId={brandId} snapshot={machine} filled={known.filled} /> : null}

      <details className="rounded-lg border border-border bg-surface p-5">
        <summary className="cursor-pointer text-base font-semibold text-fg">Brand details</summary>
        <form onSubmit={handleSubmit(submit)} className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label="Name" error={errors.name?.message} required><TextInput {...register("name")} maxLength={120} required disabled={!canEdit} /></Field>
          <Field label="Website" error={errors.website?.message}><TextInput {...register("website")} maxLength={500} disabled={!canEdit} /></Field>
          <Field label="Industry" error={errors.industry?.message}><TextInput {...register("industry")} maxLength={120} disabled={!canEdit} /></Field>
          <Field label="Category" error={errors.category?.message}><TextInput {...register("category")} maxLength={120} disabled={!canEdit} /></Field>
          <Field label="Country or market" error={errors.country?.message}><TextInput {...register("country")} maxLength={80} disabled={!canEdit} /></Field>
          <div className="md:col-span-2"><Field label="What you sell" error={errors.sells?.message}><TextArea {...register("sells")} maxLength={500} disabled={!canEdit} /></Field></div>
          <div className="md:col-span-2"><Field label="Description" error={errors.description?.message}><TextArea {...register("description")} maxLength={2000} disabled={!canEdit} /></Field></div>
          {saveError ? <div className="md:col-span-2"><Notice>{saveError}</Notice></div> : null}
          {isDirty ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm md:col-span-2" role="status"><span>Unsaved changes</span><Button type="button" variant="quiet" onClick={() => reset({ ...detail.identity, targetCustomers: detail.brain.targetCustomers })}>Discard changes</Button></div> : null}
          {canEdit ? <Button type="submit" disabled={pending || isSubmitting}>{pending || isSubmitting ? "Saving…" : "Save brand details"}</Button> : null}
        </form>
      </details>

      {canDelete ? (
        <section className="space-y-3 rounded-lg border border-danger/40 bg-surface p-5" aria-labelledby="danger-zone-title">
          <h2 id="danger-zone-title" className="text-base font-semibold text-fg">Danger zone</h2>
          <p className="text-sm text-fg-muted">Deleting this brand removes it from your workspace and leaves an audit record.</p>
          <AlertDialog open={deleteOpen} onOpenChange={(open) => { setDeleteOpen(open); if (!open) setDeleteText(""); }}>
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete brand</Button>
            <AlertDialogContent aria-describedby="delete-brand-description">
              <AlertDialogTitle>Delete {detail.identity.name}?</AlertDialogTitle>
              <AlertDialogDescription id="delete-brand-description">This action cannot be undone. Type the brand name to confirm.</AlertDialogDescription>
              <div className="mt-4 space-y-4">
                <Field label={`Type “${detail.identity.name}” to confirm`}><TextInput value={deleteText} onChange={(event) => setDeleteText(event.target.value)} autoComplete="off" /></Field>
                <div className="flex justify-end gap-2">
                  <AlertDialogCancel asChild><Button variant="secondary">Cancel</Button></AlertDialogCancel>
                  <AlertDialogAction asChild>
                    <Button variant="danger" disabled={deleteText !== detail.identity.name || pending} onClick={(event) => {
                      event.preventDefault();
                      void run(async () => {
                        await deleteBrand({ data: { brandId } });
                        await reload();
                        await navigate({ to: "/" });
                      });
                    }}>Delete brand</Button>
                  </AlertDialogAction>
                </div>
              </div>
            </AlertDialogContent>
          </AlertDialog>
        </section>
      ) : null}
    </div>
  );
}

type PipelineState = "done" | "in progress" | "blocked" | "not started";
type PipelineStep = { label: string; to: "/brands/$brandId/market" | "/brands/$brandId/opportunities" | "/brands/$brandId/studio" | "/brands/$brandId/learning"; count: number | null; state: PipelineState };

function pipelineSteps(snapshot: MachineSnapshot, filled: number): PipelineStep[] {
  const researchCount = snapshot.counts.observations + snapshot.counts.documents;
  const hasMarket = researchCount > 0;
  const hasOpportunity = snapshot.counts.openOpportunities > 0;
  const hasReview = snapshot.counts.reviews > 0;
  const hasPublish = snapshot.operating.publishedTests > 0;
  const hasPerformance = snapshot.counts.performanceRows > 0;
  const hasLearning = snapshot.counts.patterns > 0;
  const candidates: Omit<PipelineStep, "state">[] = [
    { label: "Market", to: "/brands/$brandId/market", count: snapshot.counts.competitors },
    { label: "Research", to: "/brands/$brandId/market", count: researchCount },
    { label: "Opportunity", to: "/brands/$brandId/opportunities", count: snapshot.counts.openOpportunities },
    { label: "Decision", to: "/brands/$brandId/opportunities", count: snapshot.counts.openOpportunities },
    { label: "Brief", to: "/brands/$brandId/studio", count: null },
    { label: "Studio", to: "/brands/$brandId/studio", count: snapshot.operating.generationRuns },
    { label: "Review", to: "/brands/$brandId/studio", count: snapshot.counts.reviews },
    { label: "Publish", to: "/brands/$brandId/studio", count: snapshot.operating.publishedTests },
    { label: "Performance", to: "/brands/$brandId/learning", count: snapshot.counts.performanceRows },
    { label: "Learning", to: "/brands/$brandId/learning", count: snapshot.counts.patterns },
  ];
  const completed = [hasMarket, hasMarket, hasOpportunity, hasOpportunity, snapshot.counts.creatives > 0, snapshot.operating.generationRuns > 0, hasReview, hasPublish, hasPerformance, hasLearning];
  const firstPending = completed.findIndex((done) => !done);
  return candidates.map((step, index) => ({
    ...step,
    state: completed[index]
      ? "done"
      : [2, 3, 4, 5].includes(index) && !hasMarket
        ? "blocked"
        : index === firstPending && filled >= 4
          ? "in progress"
          : "not started",
  }));
}

function stateVariant(state: PipelineState): "success" | "info" | "warning" | "neutral" {
  if (state === "done") return "success";
  if (state === "in progress") return "info";
  if (state === "blocked") return "warning";
  return "neutral";
}

function Pipeline({ brandId, snapshot, filled }: { brandId: string; snapshot: MachineSnapshot; filled: number }) {
  return (
    <section aria-labelledby="pipeline-title" className="space-y-3">
      <h2 id="pipeline-title" className="text-section font-semibold text-fg">Advertising pipeline</h2>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {pipelineSteps(snapshot, filled).map((step) => (
          <li key={step.label}>
            <Link to={step.to} params={{ brandId }} className="flex h-full flex-col gap-2 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-accent focus-visible:outline-2">
              <span className="font-semibold text-fg">{step.label}{step.count !== null ? <span className="ml-1 font-normal text-fg-muted">({step.count})</span> : null}</span>
              <Badge variant={stateVariant(step.state)} className="self-start">{step.state}</Badge>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

function NextAction({ brandId, snapshot, filled }: { brandId: string; snapshot: MachineSnapshot; filled: number }) {
  const next = filled < 4
    ? { label: "Complete the brand brain", to: "/brands/$brandId/brain" as const, state: "in progress" }
    : pipelineSteps(snapshot, filled).find((step) => step.state !== "done" && step.state !== "blocked");
  const action = next ?? { label: "Review current learning", to: "/brands/$brandId/learning" as const, state: "done", count: null };
  const recommendation = snapshot.operating.recommendation;
  return (
    <Card className="space-y-3 border-accent/40 bg-accent-soft/40">
      <p className="eyebrow">Next best action</p>
      <h2 className="text-xl font-semibold text-fg">{recommendation && action.label === "Opportunity" ? recommendation.label : action.label}</h2>
      <p className="max-w-2xl text-sm text-fg-muted">{recommendation && action.label === "Opportunity" ? recommendation.reason : action.state === "done" ? "Your stored pipeline is up to date. Review the latest learning and decide what to explore next." : `Continue with ${action.label.toLowerCase()} using the evidence already stored for this brand.`}</p>
      <Button asChild><Link to={action.to} params={{ brandId }}>{action.state === "done" ? "Open learning" : `Continue to ${action.label}`}</Link></Button>
    </Card>
  );
}

// Chart colors come from the theme tokens. Fills use currentColor (set on the wrapper), and axis text uses fg-muted.
const chartTooltipStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, color: "var(--color-fg)", fontSize: 12 };

function ChartPanel({ title, description, label, children }: { title: string; description: string; label: string; children: ReactNode }) {
  return <Card className="space-y-3">
    <div><h2 className="text-base font-semibold text-fg">{title}</h2><p className="text-sm text-fg-muted">{description}</p></div>
    <div role="img" aria-label={label} className="h-52 text-accent [&_.recharts-cartesian-axis-tick-value]:fill-fg-muted [&_line]:stroke-border">{children}</div>
  </Card>;
}

function OpportunityChart({ rows }: { rows: { expectedValue: number; status: string }[] }) {
  const open = rows.filter((row) => row.status === "open");
  if (!open.length) return null;
  const bins = [
    { range: "0–0.25", count: open.filter((row) => row.expectedValue < 0.25).length },
    { range: "0.25–0.5", count: open.filter((row) => row.expectedValue >= 0.25 && row.expectedValue < 0.5).length },
    { range: "0.5–0.75", count: open.filter((row) => row.expectedValue >= 0.5 && row.expectedValue < 0.75).length },
    { range: "0.75–1", count: open.filter((row) => row.expectedValue >= 0.75).length },
  ];
  return <ChartPanel title="Open opportunity rank distribution" description="Stored JEV expected-value scores" label="Open opportunities grouped by stored expected value">
    <ResponsiveContainer width="100%" height="100%"><BarChart data={bins} margin={{ left: -20, right: 8, top: 8, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="range" /><YAxis allowDecimals={false} /><Tooltip cursor={{ fill: "currentColor", fillOpacity: 0.08 }} contentStyle={chartTooltipStyle} /><Bar dataKey="count" name="Opportunities" fill="currentColor" radius={[4, 4, 0, 0]}>{bins.map((entry) => <Cell key={entry.range} />)}</Bar></BarChart></ResponsiveContainer>
  </ChartPanel>;
}

function ReviewAgeChart({ rows }: { rows: { status: string; createdAt: string }[] }) {
  const open = rows.filter((row) => row.status === "open");
  if (!open.length) return null;
  const now = Date.now();
  const ages = [
    { range: "< 1 day", count: open.filter((row) => now - Date.parse(row.createdAt) < 86_400_000).length },
    { range: "1–7 days", count: open.filter((row) => { const age = now - Date.parse(row.createdAt); return age >= 86_400_000 && age < 7 * 86_400_000; }).length },
    { range: "> 7 days", count: open.filter((row) => now - Date.parse(row.createdAt) >= 7 * 86_400_000).length },
  ];
  return <ChartPanel title="Review queue age" description="Age from stored open-review timestamps" label="Open reviews grouped by age">
    <ResponsiveContainer width="100%" height="100%"><BarChart data={ages} margin={{ left: -20, right: 8, top: 8, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="range" /><YAxis allowDecimals={false} /><Tooltip cursor={{ fill: "currentColor", fillOpacity: 0.08 }} contentStyle={chartTooltipStyle} /><Bar dataKey="count" name="Open reviews" fill="currentColor" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer>
  </ChartPanel>;
}

function MissingList({ brandId, snapshot, filled }: { brandId: string; snapshot: MachineSnapshot; filled: number }) {
  const missing = [
    ...(filled < 4 ? [{ text: "Complete the brand brain", to: "/brands/$brandId/brain" as const }] : []),
    ...(snapshot.counts.observations === 0 ? [{ text: "Collect competitor evidence", to: "/brands/$brandId/market" as const }] : []),
    ...(snapshot.counts.openOpportunities === 0 ? [{ text: "Rank opportunities from stored evidence", to: "/brands/$brandId/opportunities" as const }] : []),
    ...(snapshot.operating.generationRuns === 0 ? [{ text: "Generate a first creative", to: "/brands/$brandId/studio" as const }] : []),
    ...(snapshot.counts.performanceRows === 0 ? [{ text: "No performance observations are stored yet", to: "/brands/$brandId/learning" as const }] : []),
  ];
  return <Card className="space-y-3">
    <h2 className="text-base font-semibold text-fg">What is missing</h2>
    {missing.length ? <ul className="grid gap-2 sm:grid-cols-2">{missing.map((item) => <li key={item.text}><Link to={item.to} params={{ brandId }} className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border px-3 text-sm font-medium text-fg transition-colors hover:border-accent"><span>{item.text}</span><ArrowRight aria-hidden="true" className="size-4 shrink-0 text-accent" /></Link></li>)}</ul> : <p className="text-sm text-fg-muted">No pipeline gaps are currently visible in the stored brand data.</p>}
  </Card>;
}
