import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button, Card, CardDescription, CardHeader, CardTitle, EmptyState, Input, PageHeader, ScreenSkeleton, SelectInput, toast } from "@/components/ui";
import { PlainErrorState } from "@/components/plain-error";
import { useWorkspace } from "@/components/workspace";
import { AdminOnlyNotice } from "@/components/ops/ops-shared";
import { hasRole } from "@/lib/meridian/access";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { userScopedQueryKey } from "@/lib/query/keys";
import { createContentFactorySession, getBrandEconomics, getBrandHookHistory, getContentFactorySession, listContentFactorySessions, readContentFactoryRun } from "@/lib/meridian/content-factory/actions";
import type { BrandEconomics } from "@/lib/meridian/content-factory/economics";
import type { HookHistory } from "@/lib/meridian/content-factory/hook-history";
import { MAX_TITLE_CHARS, type SessionSummary } from "@/lib/meridian/content-factory/model";
import { BatchCard } from "./batch-panel";
import { GovernanceCard } from "./governance-panel";
import { ChatPanel } from "./chat-panel";
import { OrchestratorModelPanel } from "./orchestrator-model-panel";
import { OrchestratorPlans } from "./orchestrator-plans";
import { RunPanel } from "./run-panel";
import { SettingsPanel } from "./settings-panel";

/** How often the run is read while the engine may still change it. */
const RUN_POLL_MS = 4_000;

const contentFactoryKeys = {
  sessions: (organizationId: string) => ["content-factory", organizationId] as const,
  session: (sessionId: string) => ["content-factory-session", sessionId] as const,
  run: (sessionId: string) => ["content-factory-run", sessionId] as const,
};

type BrandOption = { id: string; name: string };

export function ContentFactoryScreen({ initialSessionId = null, embedded = false }: { initialSessionId?: string | null; embedded?: boolean } = {}) {
  const { data: workspace } = useWorkspace();
  const { user, isPending } = useCurrentUserState();
  const organizationId = workspace?.active?.id ?? "";
  const role = workspace?.active?.role ?? "viewer";
  const canAdmin = hasRole(role, "admin");
  const brands: BrandOption[] = (workspace?.brands ?? []).map((brand) => ({ id: brand.id, name: brand.name }));
  const sessions = useQuery({
    queryKey: userScopedQueryKey(user?.id, contentFactoryKeys.sessions(organizationId)),
    queryFn: () => listContentFactorySessions({ data: { organizationId } }),
    enabled: !isPending && !!user && canAdmin && !!organizationId,
  });
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId);
  const [creating, setCreating] = useState(false);
  const list = sessions.data ?? [];
  const selected = list.find((item) => item.id === selectedId) ?? list[0] ?? null;

  if (!workspace?.active) return null;
  // Inside the content page the page header belongs to the page, so the screen shows only its own New session button.
  const newSession = canAdmin && list.length > 0 ? <Button size="md" leftIcon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setCreating((open) => !open)}>New session</Button> : null;
  const header = embedded ? null : (
    <PageHeader
      title="Content"
      description="Start a video from any idea. Chat with instructions, attach a reference video, images, text and records from other Meridian pages, then ask for the video. Each decision the engine makes appears in the Decisions panel as it happens."
      actions={newSession}
    />
  );
  if (!canAdmin) {
    return <div className="space-y-6">{header}<AdminOnlyNotice screen="Content" role={role} /></div>;
  }
  if (sessions.isError && !sessions.data) return <div>{header}<PlainErrorState error={sessions.error} onRetry={() => void sessions.refetch()} /></div>;
  if (!sessions.data) return <ScreenSkeleton label="Loading Content sessions" shape="cards" />;

  return (
    <div className="space-y-6">
      {header}
      {embedded && newSession ? <div className="flex justify-end">{newSession}</div> : null}
      {list.length === 0 ? (
        <EmptyState
          title="No sessions yet"
          reason="A session is one chat about one video. Give it a title to start. A brand is optional, but files are kept in a brand's Google Drive folder, so a session needs a brand to take files."
          action={<NewSessionForm organizationId={organizationId} brands={brands} onCreated={(created) => { setSelectedId(created.id); }} />}
        />
      ) : null}
      {list.length > 0 && creating ? (
        <Card>
          <CardHeader><CardTitle>New session</CardTitle><CardDescription>One chat, then one video.</CardDescription></CardHeader>
          <NewSessionForm organizationId={organizationId} brands={brands} onCreated={(created) => { setSelectedId(created.id); setCreating(false); }} />
        </Card>
      ) : null}
      {selected ? (
        <>
          <div className="max-w-md">
            <label htmlFor="cf-session" className="mb-1.5 block text-sm font-semibold">Session</label>
            <SelectInput id="cf-session" value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
              {list.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.status === "started" ? "video started" : "draft"}</option>)}
            </SelectInput>
          </div>
          {selected.brandId ? (
            <>
              <HookHistoryCard
                organizationId={organizationId}
                brandId={selected.brandId}
                brandName={brands.find((brand) => brand.id === selected.brandId)?.name ?? "this brand"}
              />
              <EconomicsCard
                organizationId={organizationId}
                brandId={selected.brandId}
                brandName={brands.find((brand) => brand.id === selected.brandId)?.name ?? "this brand"}
              />
              <BatchCard
                brandId={selected.brandId}
                brandName={brands.find((brand) => brand.id === selected.brandId)?.name ?? "this brand"}
                drafts={list.filter((item) => item.brandId === selected.brandId && item.status === "draft").map((item) => ({ id: item.id, title: item.title }))}
              />
              <GovernanceCard
                brandId={selected.brandId}
                brandName={brands.find((brand) => brand.id === selected.brandId)?.name ?? "this brand"}
              />
            </>
          ) : null}
          <SessionView key={selected.id} session={selected} brands={brands} userId={user?.id ?? null} />
        </>
      ) : null}
      <OrchestratorPlans />
      <OrchestratorModelPanel organizationId={organizationId} />
    </div>
  );
}

function NewSessionForm({ organizationId, brands, onCreated }: { organizationId: string; brands: BrandOption[]; onCreated: (session: SessionSummary) => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [brandId, setBrandId] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const created = await createContentFactorySession({ data: { organizationId, brandId: brandId || null, title } });
      await queryClient.invalidateQueries({ queryKey: ["user"], predicate: (query) => query.queryKey.includes("content-factory") });
      setTitle("");
      onCreated(created);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The session was not created.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="grid w-full max-w-xl gap-3 text-left sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Input label="Title" value={title} maxLength={MAX_TITLE_CHARS} onChange={(event) => setTitle(event.target.value)} placeholder="Blender reel like the one I saved" required />
      <div className="space-y-1.5">
        <label htmlFor="cf-new-brand" className="block text-sm font-semibold">Brand (optional)</label>
        <SelectInput id="cf-new-brand" value={brandId} onChange={(event) => setBrandId(event.target.value)}>
          <option value="">No brand</option>
          {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
        </SelectInput>
      </div>
      <Button type="submit" size="md" loading={busy} disabled={busy || !title.trim()} className="sm:col-span-2 sm:justify-self-start">Create session</Button>
    </form>
  );
}

function SessionView({ session, brands, userId }: { session: SessionSummary; brands: BrandOption[]; userId: string | null }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: userScopedQueryKey(userId, contentFactoryKeys.session(session.id)),
    queryFn: () => getContentFactorySession({ data: { sessionId: session.id } }),
    enabled: !!userId,
  });
  const run = useQuery({
    queryKey: userScopedQueryKey(userId, contentFactoryKeys.run(session.id)),
    queryFn: () => readContentFactoryRun({ data: { sessionId: session.id } }),
    enabled: !!userId,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.stage === "started" && data.feed.active ? RUN_POLL_MS : false;
    },
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey.some((part) => typeof part === "string" && part.startsWith("content-factory")) });
  };
  // A started session's sessions list shows its new status.
  const started = detail.data?.status === "started";
  useEffect(() => {
    if (started && session.status !== "started") refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, session.status]);

  if (detail.isError && !detail.data) return <PlainErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  if (!detail.data) return <ScreenSkeleton label="Loading the session" shape="rows" />;
  const data = detail.data;
  const hasFiles = data.messages.some((message) => message.attachments.some((item) => item.kind === "file"));
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-6">
        <ChatPanel session={data} brands={brands} files={run.data?.stage === "draft" ? run.data.files : null} onChanged={refresh} />
        {data.status === "draft" ? <SettingsPanel session={data} brands={brands} hasFiles={hasFiles} onSaved={refresh} /> : null}
      </div>
      <div className="min-w-0">
        <RunPanel sessionId={data.id} run={run} lastRefusal={data.lastRefusal} onStarted={refresh} />
      </div>
    </div>
  );
}

/**
 * The hooks of one brand's started videos, read from what the runs stored (portfolio). A repeat is shown with the videos it appears in, so a
 * person can change the wording on purpose. The count is read as it is: a video whose script has no hook is not counted as a hook.
 */
function HookHistoryCard({ organizationId, brandId, brandName }: { organizationId: string; brandId: string; brandName: string }) {
  const { user } = useCurrentUserState();
  const history = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["content-factory", "hooks", organizationId, brandId]),
    queryFn: () => getBrandHookHistory({ data: { organizationId, brandId } }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hooks in {brandName}</CardTitle>
        <CardDescription>The hook each started video opened with, read from its stored script. Repeated wording is listed so you can change it on purpose.</CardDescription>
      </CardHeader>
      {history.isError && !history.data ? <PlainErrorState error={history.error} onRetry={() => void history.refetch()} /> : null}
      {history.isPending ? <p role="status" className="text-sm text-fg-muted">Reading the hooks.</p> : null}
      {history.data ? <HookHistoryBody history={history.data} /> : null}
    </Card>
  );
}

function HookHistoryBody({ history }: { history: HookHistory }) {
  if (history.started === 0) {
    return <p className="text-sm text-fg-muted">No video has been started for this brand yet. Its hooks appear here once a run starts.</p>;
  }
  if (history.hooked === 0) {
    return (
      <p className="text-sm text-fg-muted">
        {history.started} started {history.started === 1 ? "video has" : "videos have"} no recorded hook yet. The engine writes each script after its run starts, and a hook is listed once the script exists.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm">
        {history.hooked} of {history.started} started {history.started === 1 ? "video has" : "videos have"} a recorded hook.
      </p>
      {history.repeats.length === 0 ? (
        <p className="text-sm text-fg-muted">No hook repeats. Each recorded hook is worded differently.</p>
      ) : (
        <ol className="space-y-3" aria-label="Repeated hooks">
          {history.repeats.map((group) => (
            <li key={group.records.map((record) => record.sessionId).join(":")} className="space-y-2 rounded-md border border-border bg-surface-2 p-3">
              <p className="text-sm font-semibold">{group.kind === "same" ? "Same wording" : "Similar wording (shared words)"}</p>
              <p className="text-sm">&ldquo;{group.hook}&rdquo;</p>
              <ul className="space-y-1 text-xs text-fg-muted">
                {group.records.map((record) => (
                  <li key={record.sessionId}>
                    {record.title} · {record.startedAt ? record.startedAt.slice(0, 10) : "start date not recorded"}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** A reader's money: the figure as settled, with cents for amounts of a dollar or more and four places below that. */
function moneyText(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/**
 * What one brand's video runs cost, from the engine's ledger. Billed is what a provider's bill settled. A held call is waiting for its bill: it
 * is shown with its estimate, not counted as spent. The estimate of every call is a planning figure, not spending.
 */
function EconomicsCard({ organizationId, brandId, brandName }: { organizationId: string; brandId: string; brandName: string }) {
  const { user } = useCurrentUserState();
  const economics = useQuery({
    queryKey: userScopedQueryKey(user?.id, ["content-factory", "economics", organizationId, brandId]),
    queryFn: () => getBrandEconomics({ data: { organizationId, brandId } }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Spend on {brandName}&rsquo;s video runs</CardTitle>
        <CardDescription>Billed is what a provider&rsquo;s bill settled. A held call is still waiting for its bill, so it is not counted as spent.</CardDescription>
      </CardHeader>
      {economics.isError && !economics.data ? <PlainErrorState error={economics.error} onRetry={() => void economics.refetch()} /> : null}
      {economics.isPending ? <p role="status" className="text-sm text-fg-muted">Reading the ledger.</p> : null}
      {economics.data ? <EconomicsBody economics={economics.data} /> : null}
    </Card>
  );
}

function EconomicsBody({ economics }: { economics: BrandEconomics }) {
  if (economics.runs === 0) {
    return <p className="text-sm text-fg-muted">No video run has been made for this brand yet, so nothing has been spent on it.</p>;
  }
  const perDelivered =
    economics.costPerDeliveredUsd === null
      ? "No video is delivered yet, so there is no cost per delivered video."
      : economics.costPerDeliveredFinal
        ? `${moneyText(economics.costPerDeliveredUsd)} per delivered video.`
        : `${moneyText(economics.costPerDeliveredUsd)} per delivered video so far. A call on a delivered run is still waiting for its bill, so this may change.`;
  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-fg-muted">Billed</dt>
          <dd className="text-lg font-semibold tabular-nums">{moneyText(economics.billedUsd)}</dd>
          <dd className="text-xs text-fg-muted">Settled by a provider&rsquo;s bill.</dd>
        </div>
        <div>
          <dt className="text-sm text-fg-muted">Held</dt>
          <dd className="text-lg font-semibold tabular-nums">{economics.heldCalls} {economics.heldCalls === 1 ? "call" : "calls"}</dd>
          <dd className="text-xs text-fg-muted">Estimated {moneyText(economics.heldEstimateUsd)}. Not spent yet.</dd>
        </div>
        <div>
          <dt className="text-sm text-fg-muted">Estimated for all runs</dt>
          <dd className="text-lg font-semibold tabular-nums">{moneyText(economics.estimatedUsd)}</dd>
          <dd className="text-xs text-fg-muted">A planning figure, not spending.</dd>
        </div>
      </dl>
      <p className="text-sm">{perDelivered}</p>
      <p className="text-xs text-fg-muted">
        {economics.delivered} of {economics.runs} {economics.runs === 1 ? "run" : "runs"} delivered.
      </p>
    </div>
  );
}
