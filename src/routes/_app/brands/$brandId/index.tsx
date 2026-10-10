import { Link, createFileRoute } from "@tanstack/react-router";
import { Button, ErrorState, PageHeader, ScreenSkeleton, Skeleton, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { brainCompleteness } from "@/lib/meridian/brain";
import { useBrandQuery, useMachineQuery, useOpportunitiesQuery, useReviewsQuery } from "@/lib/query/hooks";
import { countDecidedReviews, missingItems, nextBestAction, pipelineStages } from "@/components/brand-overview/pipeline";
import { PipelineStepper } from "@/components/brand-overview/pipeline-stepper";
import { NextActionCard } from "@/components/brand-overview/next-action-card";
import { MissingChecklist } from "@/components/brand-overview/missing-checklist";
import { OpportunityChart, ReviewAgeChart } from "@/components/brand-overview/review-charts";
import { BrandDetailsCard } from "@/components/brand-overview/brand-details-card";
import { DangerZone } from "@/components/brand-overview/danger-zone";

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

  if (detailQuery.isError && !detail) return <ErrorState message={errorText(detailQuery.error)} onRetry={() => void detailQuery.refetch()} />;
  if (!detail) return <ScreenSkeleton label="Loading brand" shape="cards" />;

  const known = brainCompleteness(detail.brain);
  const canDelete = hasRole(detail.identity.role, "admin");
  const canEdit = hasRole(detail.identity.role, "member");
  const reviews = reviewsQuery.data?.reviews ?? [];
  const openReviews = reviews.filter((review) => review.status === "open");
  const openOpportunities = (opportunitiesQuery.data?.opportunities ?? []).filter((opportunity) => opportunity.status === "open");
  const stages = machine
    ? pipelineStages({
      counts: machine.counts,
      operating: machine.operating,
      decidedReviews: reviewsQuery.data ? countDecidedReviews(reviews) : null,
    })
    : null;

  return (
    <div className="space-y-8">
      <PageHeader
        breadcrumbs={[{ label: "All brands", to: "/" }]}
        title={detail.identity.name}
        description={<>{known.filled} of {known.total} brand brain fields · Version {detail.version || 1}</>}
        actions={<Button asChild><Link to="/brands/$brandId/brain" params={{ brandId }}>Complete brand brain</Link></Button>}
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
          {openOpportunities.length ? <OpportunityChart rows={openOpportunities} /> : null}
          {openReviews.length ? <ReviewAgeChart rows={openReviews} /> : null}
        </div>
      ) : null}

      <BrandDetailsCard brandId={brandId} detail={detail} canEdit={canEdit} />

      {canDelete ? <DangerZone brandId={brandId} brandName={detail.identity.name} /> : null}
    </div>
  );
}
