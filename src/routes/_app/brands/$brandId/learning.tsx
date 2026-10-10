import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button, ErrorState, PageHeader, ScreenSkeleton, Tabs, TabsContent, TabsList, TabsTrigger, errorText } from "@/components/ui";
import { PatternsPanel } from "@/components/learning/patterns-panel";
import { PerformancePanel } from "@/components/learning/performance-panel";
import { SchedulePanel } from "@/components/learning/schedule-panel";
import { SharingPanel } from "@/components/learning/sharing-panel";
import { hasRole } from "@/lib/meridian/access";
import { useLearningQuery } from "@/lib/query/hooks";

export const Route = createFileRoute("/_app/brands/$brandId/learning")({ staticData: { pageTitle: "Learning" }, component: Page });

type LearningTab = "patterns" | "performance" | "schedule" | "sharing";
const tabs: Array<{ value: LearningTab; label: string }> = [
  { value: "patterns", label: "Patterns" },
  { value: "performance", label: "Performance" },
  { value: "schedule", label: "Schedule" },
  { value: "sharing", label: "Sharing" },
];

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Learning brandId={brandId} />
  );
}

function Learning({ brandId }: { brandId: string }) {
  const learningQuery = useLearningQuery(brandId);
  const data = learningQuery.data ?? null;
  const [tab, setTab] = useState<LearningTab>("patterns");

  if (learningQuery.isError && !data) return <ErrorState message={errorText(learningQuery.error)} onRetry={() => void learningQuery.refetch()} />;
  if (!data) return <ScreenSkeleton label="Loading learning" shape="cards" />;
  const canEdit = hasRole(data.role, "member");
  const canAdmin = hasRole(data.role, "admin");

  return (
    <div className="space-y-8">
      <PageHeader
        title="Learning"
        description={data.policy}
        actions={<Button asChild variant="secondary"><Link to="/brands/$brandId/calibration" params={{ brandId }}>Calibration</Link></Button>}
      />
      {/* Every panel stays mounted so a half-filled form survives a tab change. Queries run only for the open tab. */}
      <Tabs value={tab} onValueChange={(value) => setTab(value as LearningTab)} className="space-y-6">
        <TabsList aria-label="Learning sections">
          {tabs.map((item) => <TabsTrigger key={item.value} value={item.value} className="max-sm:min-h-11">{item.label}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="patterns" forceMount className="data-[state=inactive]:hidden">
          <PatternsPanel brandId={brandId} data={data} canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="performance" forceMount className="data-[state=inactive]:hidden">
          <PerformancePanel brandId={brandId} canEdit={canEdit} active={tab === "performance"} />
        </TabsContent>
        <TabsContent value="schedule" forceMount className="data-[state=inactive]:hidden">
          <SchedulePanel brandId={brandId} organizationId={data.organizationId} canAdmin={canAdmin && !!data.organizationId} />
        </TabsContent>
        <TabsContent value="sharing" forceMount className="data-[state=inactive]:hidden">
          <SharingPanel brandId={brandId} data={data} canEdit={canEdit} canAdmin={canAdmin} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
