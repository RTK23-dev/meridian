import { Link, createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { Button, ChartSkeleton, PageHeader, ScreenSkeleton, Skeleton } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { hasRole } from "@/lib/meridian/access";
import { brainCompleteness } from "@/lib/meridian/brain";
import { useBrandQuery, useMachineQuery, useOpportunitiesQuery, useReviewsQuery } from "@/lib/query/hooks";
import { missingItems, nextBestAction, pipelineStages } from "@/components/brand-overview/pipeline";
import { PipelineStepper } from "@/components/brand-overview/pipeline-stepper";
import { NextActionCard } from "@/components/brand-overview/next-action-card";
import { MissingChecklist } from "@/components/brand-overview/missing-checklist";
import { BrandDetailsCard } from "@/components/brand-overview/brand-details-card";
import { DangerZone } from "@/components/brand-overview/danger-zone";

// The two review charts use recharts. They load when the page has open items to chart, not with the rest of the overview.
const OpportunityChart = lazy(() => import("@/components/brand-overview/review-charts").then((module) => ({ default: module.OpportunityChart })));
const ReviewAgeChart = lazy(() => import("@/components/brand-overview/review-charts").then((module) => ({ default: module.ReviewAgeChart })));

export const Route = createFileRoute("/_app/brands/$brandId/")({ staticData: { pageTitle: "Overview" }, component: BrandPage });

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

  if (detailQuery.isError && !detail) return <PlainErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />;
  if (!detail) return <ScreenSkeleton label="Loading brand" shape="cards" />;

  const known = brainCompleteness(detail.brain);
  const canDelete = hasRole(detail.identity.role, "admin");
  const canEdit = hasRole(detail.identity.role, "member");
  const reviews = reviewsQuery.data?.reviews ?? [];
  const openReviews = reviews.filter((review) => review.status === "open");
  const openOpportunities = (opportunitiesQuery.data?.opportunities ?? []).filter((opportunity) => opportunity.status === "open");
  // The stage counts, including decided reviews, come from the machine snapshot over every review, not from one list page.
  const stages = machine ? pipelineStages({ counts: machine.counts, operating: machine.operating }) : null;

  return (
    <div className="space-y-8">
      <PageHeader
        breadcrumbs={[{ label: "All brands", to: "/" }]}
        title={detail.identity.name}
        description={known.requiredComplete ? (
          <>Complete brand brain · {known.requiredFilled} of {known.requiredTotal} required fields · {known.filled} of {known.total} fields · Version {detail.version || 1}</>
        ) : (
          <>Brand brain not complete · {known.requiredFilled} of {known.requiredTotal} required fields · Version {detail.version || 1}</>
        )}
        actions={<Button asChild><Link to="/brands/$brandId/brain" params={{ brandId }}>Open brand brain</Link></Button>}
      />

      {stages ? <PipelineStepper brandId={brandId} stages={stages} /> : <Skeleton variant="card" />}

      <div className="grid gap-4 lg:grid-cols-2">
        {stages && machine ? (
          <NextActionCard
            brandId={brandId}
            action={nextBestAction({
              brainFilled: known.filled,
              brainTotal: known.total,
              stages,
              recommendation: machine.operating.recommendation,
            })}
          />
        ) : <Skeleton variant="card" />}
        {machine ? (
          <MissingChecklist
            brandId={brandId}
            items={missingItems({ brainFilled: known.filled, counts: machine.counts, operating: machine.operating })}
          />
        ) : <Skeleton variant="card" />}
      </div>

      {openOpportunities.length || openReviews.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {openOpportunities.length ? <Suspense fallback={<ChartSkeleton className="h-52" />}><OpportunityChart rows={openOpportunities} /></Suspense> : null}
          {openReviews.length ? <Suspense fallback={<ChartSkeleton className="h-52" />}><ReviewAgeChart rows={openReviews} /></Suspense> : null}
        </div>
      ) : null}

      <BrandDetailsCard brandId={brandId} detail={detail} canEdit={canEdit} />

      {canDelete ? <DangerZone brandId={brandId} brandName={detail.identity.name} /> : null}
    </div>
  );
}
