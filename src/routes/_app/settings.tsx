import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertsPanel } from "@/components/alerts-panel";
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { GeneralTab } from "@/components/settings/general-tab";
import { MembersTab } from "@/components/settings/members-tab";
import { WeightsTab } from "@/components/settings/weights-tab";
import { LearningTab } from "@/components/settings/learning-tab";
import { DangerTab } from "@/components/settings/danger-tab";
import { hasRole } from "@/lib/meridian/access";

export const Route = createFileRoute("/_app/settings")({ staticData: { pageTitle: "Settings" }, component: SettingsPage });

type SettingsTab = "general" | "members" | "weights" | "alerts" | "learning" | "danger";

const TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "members", label: "Members" },
  { id: "weights", label: "Scoring weights" },
  { id: "alerts", label: "Alerts" },
  { id: "learning", label: "Learning" },
  { id: "danger", label: "Danger zone" },
];

function SettingsPage() {
  const { data } = useWorkspace();
  const [tab, setTab] = useState<SettingsTab>("general");
  if (!data?.active) return <p className="text-fg-muted">Create a workspace first.</p>;
  const active = data.active;
  const canAdmin = hasRole(active.role, "admin");

  return (
    <div className="space-y-6">
      <PageHeader
        title={active.name}
        description={`You are ${active.role}. Permission checks run on the server, not only in this screen.`}
        breadcrumbs={[{ label: "Overview", to: "/" }]}
      />
      <Tabs value={tab} onValueChange={(value) => setTab(value as SettingsTab)} className="space-y-6">
        <TabsList aria-label="Settings sections" className="w-full flex-nowrap overflow-x-auto border-border">
          {TABS.map((item) => (
            <TabsTrigger key={item.id} value={item.id} className="shrink-0 max-sm:min-h-11">{item.label}</TabsTrigger>
          ))}
        </TabsList>

        {/* General and Weights keep their drafts when the person switches tabs, so they stay mounted (hidden). */}
        <TabsContent value="general" forceMount className="data-[state=inactive]:hidden">
          <GeneralTab organizationId={active.id} name={active.name} canAdmin={canAdmin} />
        </TabsContent>

        <TabsContent value="members">
          <MembersTab organizationId={active.id} members={data.members} invites={data.invites} canAdmin={canAdmin} />
        </TabsContent>

        <TabsContent value="weights" forceMount className="data-[state=inactive]:hidden">
          <WeightsTab organizationId={active.id} saved={active.weights} canAdmin={canAdmin} />
        </TabsContent>

        <TabsContent value="alerts">
          {canAdmin ? <AlertsPanel organizationId={active.id} /> : <p className="text-sm text-fg-muted">Only an admin can change alert delivery.</p>}
        </TabsContent>

        <TabsContent value="learning">
          <LearningTab brands={data.brands} />
        </TabsContent>

        <TabsContent value="danger">
          <DangerTab brands={data.brands} canDelete={canAdmin} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
