import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BrandNav } from "@/components/brand-nav";
import { useBusy } from "@/components/gate";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogTitle, Button, ErrorState, Field, Notice, Panel, Skeleton, TextArea, TextInput,
} from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { hasRole } from "@/lib/meridian/access";
import { deleteBrand, updateBrand } from "@/lib/meridian/api";
import { brainCompleteness } from "@/lib/meridian/brain";
import type { MachineSnapshot } from "@/lib/meridian/machine";
import { errorText } from "@/components/ui";
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
    <div className="space-y-6">
      <BrandNav brandId={brandId} />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to="/" className="text-sm text-muted">All brands</Link>
          <h1 className="font-display text-4xl">{detail.identity.name}</h1>
          <p className="text-muted">{known.filled} of {known.total} brand brain fields · Version {detail.version || 1}</p>
        </div>
        <Button asChild><Link to="/brands/$brandId/brain" params={{ brandId }}>Complete brand brain</Link></Button>
      </header>

      {machine ? <Pipeline brandId={brandId} snapshot={machine} filled={known.filled} /> : <Skeleton variant="card" />}
      {machine ? (
        <NextAction brandId={brandId} snapshot={machine} filled={known.filled} />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <OpportunityChart rows={opportunitiesQuery.data?.opportunities ?? []} />
        <ReviewAgeChart rows={reviewsQuery.data?.reviews ?? []} />
      </div>

      {machine ? <MissingList brandId={brandId} snapshot={machine} filled={known.filled} /> : null}

      <details className="rounded-xl border border-border bg-surface p-4">
        <summary className="cursor-pointer font-semibold">Brand details</summary>
        <form onSubmit={handleSubmit(submit)} className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label="Name" error={errors.name?.message} required><TextInput {...register("name")} maxLength={120} required disabled={!canEdit} /></Field>
          <Field label="Website" error={errors.website?.message}><TextInput {...register("website")} maxLength={500} disabled={!canEdit} /></Field>
          <Field label="Industry" error={errors.industry?.message}><TextInput {...register("industry")} maxLength={120} disabled={!canEdit} /></Field>
          <Field label="Category" error={errors.category?.message}><TextInput {...register("category")} maxLength={120} disabled={!canEdit} /></Field>
          <Field label="Country or market" error={errors.country?.message}><TextInput {...register("country")} maxLength={80} disabled={!canEdit} /></Field>
          <div className="md:col-span-2"><Field label="What you sell" error={errors.sells?.message}><TextArea {...register("sells")} maxLength={500} disabled={!canEdit} /></Field></div>
          <div className="md:col-span-2"><Field label="Description" error={errors.description?.message}><TextArea {...register("description")} maxLength={2000} disabled={!canEdit} /></Field></div>
          {saveError ? <div className="md:col-span-2"><Notice>{saveError}</Notice></div> : null}
          {isDirty ? <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-soft p-3 text-sm" role="status"><span>Unsaved changes</span><Button type="button" variant="quiet" onClick={() => reset({ ...detail.identity, targetCustomers: detail.brain.targetCustomers })}>Discard changes</Button></div> : null}
          {canEdit ? <Button type="submit" disabled={pending || isSubmitting}>{pending || isSubmitting ? "Saving…" : "Save brand details"}</Button> : null}
        </form>
      </details>

      {canDelete ? (
        <section className="rounded-xl border border-danger/40 p-4" aria-labelledby="danger-zone-title">
          <h2 id="danger-zone-title" className="font-display text-xl">Danger zone</h2>
          <p className="mt-1 text-sm text-muted">Deleting this brand removes it from your workspace and leaves an audit record.</p>
          <AlertDialog open={deleteOpen} onOpenChange={(open) => { setDeleteOpen(open); if (!open) setDeleteText(""); }}>
            <Button variant="danger" className="mt-3" onClick={() => setDeleteOpen(true)}>Delete brand</Button>
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

type PipelineStep = { label: string; to: "/brands/$brandId/market" | "/brands/$brandId/opportunities" | "/brands/$brandId/studio" | "/brands/$brandId/learning"; count: number | null; state: "done" | "in progress" | "blocked" | "not started" };

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

function Pipeline({ brandId, snapshot, filled }: { brandId: string; snapshot: MachineSnapshot; filled: number }) {
  return (
    <section aria-labelledby="pipeline-title" className="space-y-3">
      <h2 id="pipeline-title" className="font-display text-2xl">Advertising pipeline</h2>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {pipelineSteps(snapshot, filled).map((step) => (
          <li key={step.label}>
            <Link to={step.to} params={{ brandId }} className="block h-full rounded-lg border border-border p-3 hover:border-brass focus-visible:outline focus-visible:outline-2">
              <span className="block font-semibold">{step.label}{step.count !== null ? <span className="ml-1 text-muted">({step.count})</span> : null}</span>
              <span className="mt-1 block text-xs text-muted">{step.state}</span>
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
    <Panel className="border-brass/40 bg-brass/5">
      <p className="text-xs font-semibold uppercase tracking-widest text-brass">Next best action</p>
      <h2 className="mt-2 font-display text-2xl">{recommendation && action.label === "Opportunity" ? recommendation.label : action.label}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">{recommendation && action.label === "Opportunity" ? recommendation.reason : action.state === "done" ? "Your stored pipeline is up to date. Review the latest learning and decide what to explore next." : `Continue with ${action.label.toLowerCase()} using the evidence already stored for this brand.`}</p>
      <Button asChild className="mt-4"><Link to={action.to} params={{ brandId }}>{action.state === "done" ? "Open learning" : `Continue to ${action.label}`}</Link></Button>
    </Panel>
  );
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
  return <Panel><h2 className="font-display text-xl">Open opportunity rank distribution</h2><p className="text-sm text-muted">Stored JEV expected-value scores</p><div className="mt-3 h-52" role="img" aria-label="Open opportunities grouped by stored expected value">
    <ResponsiveContainer width="100%" height="100%"><BarChart data={bins} margin={{ left: -20, right: 8, top: 8, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="range" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="count" name="Opportunities" fill="hsl(var(--brass))" radius={[4, 4, 0, 0]}>{bins.map((entry) => <Cell key={entry.range} />)}</Bar></BarChart></ResponsiveContainer>
  </div></Panel>;
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
  return <Panel><h2 className="font-display text-xl">Review queue age</h2><p className="text-sm text-muted">Age from stored open-review timestamps</p><div className="mt-3 h-52" role="img" aria-label="Open reviews grouped by age">
    <ResponsiveContainer width="100%" height="100%"><BarChart data={ages} margin={{ left: -20, right: 8, top: 8, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="range" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="count" name="Open reviews" fill="hsl(var(--brass))" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer>
  </div></Panel>;
}

function MissingList({ brandId, snapshot, filled }: { brandId: string; snapshot: MachineSnapshot; filled: number }) {
  const missing = [
    ...(filled < 4 ? [{ text: "Complete the brand brain", to: "/brands/$brandId/brain" as const }] : []),
    ...(snapshot.counts.observations === 0 ? [{ text: "Collect competitor evidence", to: "/brands/$brandId/market" as const }] : []),
    ...(snapshot.counts.openOpportunities === 0 ? [{ text: "Rank opportunities from stored evidence", to: "/brands/$brandId/opportunities" as const }] : []),
    ...(snapshot.operating.generationRuns === 0 ? [{ text: "Generate a first creative", to: "/brands/$brandId/studio" as const }] : []),
    ...(snapshot.counts.performanceRows === 0 ? [{ text: "No performance observations are stored yet", to: "/brands/$brandId/learning" as const }] : []),
  ];
  return <Panel><h2 className="font-display text-xl">What is missing</h2>{missing.length ? <ul className="mt-2 grid gap-2 sm:grid-cols-2">{missing.map((item) => <li key={item.text}><Link to={item.to} params={{ brandId }} className="text-sm font-semibold underline underline-offset-4">{item.text} →</Link></li>)}</ul> : <p className="mt-2 text-sm text-muted">No pipeline gaps are currently visible in the stored brand data.</p>}</Panel>;
}
