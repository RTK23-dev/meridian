import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, KpiCard,
  Panel, ScreenSkeleton, Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui";
import { plainError } from "@/lib/copy";
import {
  useAccountIntelligenceQuery,
  useIntelligenceQuery,
  usePendingVariables,
  useUpdateWhitespaceStatus,
} from "@/lib/query/hooks";
import { hasRole } from "@/lib/meridian/access";
import { ClusterCards } from "@/components/market/intelligence-clusters";
import { TraitBarChart, traitRows } from "@/components/market/intelligence-patterns";
import { WhitespaceRanking } from "@/components/market/intelligence-whitespace";
import {
  Activity,
  AlertTriangle,
  Clock,
  Compass,
  Layers,
  Sparkles,
  TrendingUp,
  Volume2,
  Zap,
} from "lucide-react";

export const Route = createFileRoute("/_app/brands/$brandId/intelligence")({ staticData: { pageTitle: "Intelligence" }, component: Page });

function Page() {
  const { brandId } = Route.useParams();
  return <Intelligence brandId={brandId} />;
}

function Intelligence({ brandId }: { brandId: string }) {
  const [platform, setPlatform] = useState<string>("instagram");
  const baseQuery = useIntelligenceQuery(brandId);
  const accountQuery = useAccountIntelligenceQuery(brandId, platform);
  const updateStatusMutation = useUpdateWhitespaceStatus(brandId);
  const whitespacePending = usePendingVariables<{ opportunityId: string }>(["mutation", "whitespace.status", brandId]).map((vars) => vars.opportunityId);

  const baseData = baseQuery.data ?? null;
  const accountData = accountQuery.data ?? null;
  // A failed refetch is shown only when there is nothing stored to keep showing.
  const error = baseQuery.error && !baseData
    ? plainError(baseQuery.error)
    : accountQuery.error && !accountData
    ? plainError(accountQuery.error)
    : null;

  if (error) {
    return (
      <ErrorState
        message={error.message}
        detail={error.raw}
        onRetry={() => {
          void baseQuery.refetch();
          void accountQuery.refetch();
        }}
      />
    );
  }

  if (!baseData || !accountData) {
    return <ScreenSkeleton label="Loading creative intelligence" shape="cards" />;
  }

  const role = accountData.role;
  const canEdit = hasRole(role, "member");
  const profile = accountData.profile;
  const whitespace = accountData.whitespace;
  const analyses = accountData.analyses;

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-brass">
              JEV Cognitive Engine
            </span>
            <Badge variant="info">
              Multimodal 2.0
            </Badge>
          </div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            Account & Creative Intelligence
          </h1>
          <p className="mt-1 text-sm text-muted">
            Macro-portfolio rollups, 6-beat creative DNA decomposition, and competitor whitespace discovery.
          </p>
          <p className="mt-1 text-xs text-muted">Counts describe stored posts and creatives, not ad effectiveness or causation.</p>
        </div>
      </div>

      <Tabs defaultValue="account" className="space-y-6">
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          <TabsTrigger value="account" className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            <span>Account DNA</span>
          </TabsTrigger>
          <TabsTrigger value="whitespace" className="flex items-center gap-2">
            <Compass className="h-4 w-4" />
            <span>Whitespace ({whitespace.length})</span>
          </TabsTrigger>
          <TabsTrigger value="semantic" className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            <span>Semantic Memory</span>
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: ACCOUNT DNA & MULTIMODAL */}
        <TabsContent value="account" className="space-y-6">
          {/* Platform Selector Bar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line pb-4">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">Platform:</span>
            {["instagram", "tiktok", "youtube"].map((p) => (
              <Button
                key={p}
                size="sm"
                variant={platform === p ? "primary" : "secondary"}
                aria-pressed={platform === p}
                onClick={() => setPlatform(p)}
                className="capitalize"
              >
                {p === "youtube" ? "YouTube Shorts" : p}
              </Button>
            ))}
          </div>

          {profile ? (
            <>
              {/* KPIs */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard
                  label="Posts Analyzed"
                  value={profile.postCount.toString()}
                  description={`Rolling ${profile.rollingWindowDays}-day window`}
                />
                <KpiCard
                  label="Avg. Engagement Rate"
                  value={`${(profile.avgEngagementRate * 100).toFixed(2)}%`}
                  description="Likes + comments + shares / views"
                />
                <KpiCard
                  label="Posting Cadence"
                  value={
                    profile.postingCadenceHours > 0
                      ? `Every ${profile.postingCadenceHours.toFixed(1)}h`
                      : "Irregular"
                  }
                  description="Median interval between posts"
                />
                <Card className="flex flex-col justify-between p-4">
                  <div>
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                      Brand Archetype
                    </span>
                    <div className="mt-2 flex items-center gap-2">
                      <Sparkles className="h-5 w-5 text-brass" />
                      <span className="font-display text-xl font-semibold capitalize text-foreground">
                        {profile.brandArchetype.replace(/_/g, " ") || "UGC Authentic"}
                      </span>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-muted">Classified from dominant visual & hook patterns</p>
                </Card>
              </div>

              {/* Two Column Breakdown: Decile Lift + Hooks */}
              <div className="grid gap-6 md:grid-cols-2">
                {/* Top vs Bottom Decile */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base font-semibold">
                      <TrendingUp className="h-4 w-4 text-success" />
                      Top 10% vs. Bottom 10% Creative Trait Lift
                    </CardTitle>
                    <CardDescription>
                      Traits stored for the top and bottom decile of posts, with how many posts carry each trait.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {Object.keys(profile.topDecileTraits).length === 0 && Object.keys(profile.bottomDecileTraits).length === 0 ? (
                      <p className="text-sm text-muted">More post volume needed for decile statistical separation.</p>
                    ) : (
                      <>
                        <TraitBarChart
                          title="Winning patterns (top decile)"
                          description="Counts of posts in the top decile that carry each trait."
                          rows={traitRows(profile.topDecileTraits)}
                          tone="success"
                        />
                        <TraitBarChart
                          title="Underperforming patterns (bottom decile)"
                          description="Counts of posts in the bottom decile that carry each trait."
                          rows={traitRows(profile.bottomDecileTraits)}
                          tone="danger"
                        />
                      </>
                    )}
                  </CardContent>
                </Card>

                {/* Top Hooks & Saturated Angles */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base font-semibold">
                      <Zap className="h-4 w-4 text-brass" />
                      Top Hooks & Angle Saturation
                    </CardTitle>
                    <CardDescription>
                      High-retention opening hooks and angles flagged as overused.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wider text-muted">
                        High Frequency Hooks
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {profile.topHooks.length === 0 ? (
                          <span className="text-sm text-muted">No hook patterns recorded.</span>
                        ) : (
                          profile.topHooks.map((hook) => (
                            <Badge key={hook} variant="neutral" className="capitalize">
                              {hook.replace(/_/g, " ")}
                            </Badge>
                          ))
                        )}
                      </div>
                    </div>
                    <div className="pt-2 border-t border-line">
                      <p className="text-xs font-medium uppercase tracking-wider text-warning flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Saturated Angles (&ge; 30% of content)
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {profile.saturatedAngles.length === 0 ? (
                          <span className="text-sm text-muted">No angle has reached saturation limits.</span>
                        ) : (
                          profile.saturatedAngles.map((angle) => (
                            <Badge key={angle} variant="warning" className="capitalize">
                              {angle.replace(/_/g, " ")}
                            </Badge>
                          ))
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Multimodal Decomposition Feed */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-lg font-semibold text-foreground">
                    Multimodal Creative DNA Stream
                  </h3>
                  <span className="text-xs text-muted">
                    {analyses.length} content analyses recorded
                  </span>
                </div>

                {analyses.length === 0 ? (
                  <Panel>
                    <p className="text-sm text-muted">
                      No individual post analyses stored yet. Connect an account in the Accounts tab to ingest content.
                    </p>
                  </Panel>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {analyses.map((item) => (
                      <Card key={item.id ?? item.postId} className="space-y-3 p-4">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs text-muted truncate max-w-[150px]">
                            {item.postId}
                          </span>
                          <Badge variant="neutral" className="capitalize text-xs">
                            {item.visualStyle || "ugc"}
                          </Badge>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="rounded bg-panel/80 p-2">
                            <span className="text-muted block">3s Retention</span>
                            <span className="font-semibold text-success">
                              {((item.threeSecondRetention ?? 0) * 100).toFixed(1)}%
                            </span>
                          </div>
                          <div className="rounded bg-panel/80 p-2">
                            <span className="text-muted block">Hook Visual</span>
                            <span className="font-semibold text-brass">
                              {((item.hookVisualScore ?? 0) * 100).toFixed(0)} / 100
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 text-xs text-muted">
                          <span className="flex items-center gap-1">
                            <Volume2 className="h-3 w-3" aria-hidden="true" />
                            {(item.speechWpm ?? 0) > 0 ? `${item.speechWpm} WPM` : "Music"}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" aria-hidden="true" />
                            Cut cadence
                          </span>
                        </div>

                        {item.detectedObjections && item.detectedObjections.length > 0 && (
                          <div className="border-t border-line pt-2">
                            <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
                              Mined Objections:
                            </span>
                            <p className="mt-1 text-xs text-warning truncate">
                              {item.detectedObjections.join(", ")}
                            </p>
                          </div>
                        )}
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <Panel className="space-y-3 py-8 text-center">
              <Compass className="mx-auto h-8 w-8 text-brass" aria-hidden="true" />
              <h3 className="font-display text-lg font-semibold">No profile for {platform}</h3>
              <p className="mx-auto max-w-md text-sm text-muted">
                JEV computes rolling portfolio profiles automatically once accounts are connected and content is ingested.
              </p>
              <div className="pt-2">
                <Button variant="secondary" asChild>
                  <Link to="/brands/$brandId/accounts" params={{ brandId }}>
                    Connect {platform} account &rarr;
                  </Link>
                </Button>
              </div>
            </Panel>
          )}
        </TabsContent>

        {/* TAB 2: COMPETITOR WHITESPACE */}
        <TabsContent value="whitespace" className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-xl font-semibold">Competitor Whitespace Radar</h2>
              <p className="text-sm text-muted">
                Unsaturated angles ranked by expected win probability from market observation and creative gap analysis.
              </p>
            </div>
          </div>

          {whitespace.length === 0 ? (
            <Panel className="py-8 text-center">
              <Compass className="mx-auto h-8 w-8 text-brass" aria-hidden="true" />
              <h3 className="mt-3 font-display text-lg font-semibold">No whitespace opportunities detected</h3>
              <p className="mt-1 text-sm text-muted">
                As market evidence and competitor campaigns are collected, JEV automatically flags high-probability gaps.
              </p>
            </Panel>
          ) : (
            <WhitespaceRanking
              items={whitespace}
              brandId={brandId}
              canEdit={canEdit}
              pendingIds={whitespacePending}
              onStatus={(opportunityId, status) => updateStatusMutation.mutate({ opportunityId, status })}
            />
          )}
        </TabsContent>

        {/* TAB 3: SEMANTIC MEMORY & NOTICES */}
        <TabsContent value="semantic" className="space-y-6">
          <div className="max-w-2xl space-y-2">
            <h2 className="font-display text-2xl">Stored Semantic Memory</h2>
            <p className="text-muted text-sm">
              {baseData.semanticNote} Structured angle counts below are fingerprints. They are not a substitute for local:semantic vectors.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <Panel>
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">Competitor rows</p>
              <p className="mt-2 font-display text-3xl">{baseData.competitorCount}</p>
            </Panel>
            <Panel>
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">This brand</p>
              <p className="mt-2 font-display text-3xl">{baseData.ownCount}</p>
            </Panel>
            <Panel>
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">Angle Gaps</p>
              <p className="mt-2 text-sm">
                {baseData.whitespace.length === 0
                  ? "No competitor angle is missing from this brand."
                  : baseData.whitespace.join(", ")}
              </p>
            </Panel>
          </div>

          <ClusterCards angleClusters={baseData.angleClusters} semanticClusters={baseData.semanticClusters} />

          <Panel>
            <h3 className="font-display text-lg font-semibold">System Notices</h3>
            {baseData.notifications.length === 0 ? (
              <p className="mt-2 text-muted text-sm">No notices yet.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {baseData.notifications.map((item) => (
                  <li key={`${item.createdAt}-${item.title}`}>
                    <span className="font-semibold">{item.title}</span>
                    <span className="block text-muted">{item.body}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
