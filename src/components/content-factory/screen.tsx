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
import { createContentFactorySession, getContentFactorySession, listContentFactorySessions, readContentFactoryRun } from "@/lib/meridian/content-factory/actions";
import { MAX_TITLE_CHARS, type SessionSummary } from "@/lib/meridian/content-factory/model";
import { ChatPanel } from "./chat-panel";
import { OrchestratorModelPanel } from "./orchestrator-model-panel";
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

export function ContentFactoryScreen() {
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = sessions.data ?? [];
  const selected = list.find((item) => item.id === selectedId) ?? list[0] ?? null;

  if (!workspace?.active) return null;
  const header = (
    <PageHeader
      title="Content Factory"
      description="Start a video from any idea. Chat with instructions, attach a reference video, images, text and records from other Meridian pages, then ask for the video. Each decision the engine makes appears in the Decisions panel as it happens."
      actions={canAdmin && list.length > 0 ? <Button size="md" leftIcon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setCreating((open) => !open)}>New session</Button> : null}
    />
  );
  if (!canAdmin) {
    return <div className="space-y-6">{header}<AdminOnlyNotice screen="Content Factory" role={role} /></div>;
  }
  if (sessions.isError && !sessions.data) return <div>{header}<PlainErrorState error={sessions.error} onRetry={() => void sessions.refetch()} /></div>;
  if (!sessions.data) return <ScreenSkeleton label="Loading Content Factory sessions" shape="cards" />;

  return (
    <div className="space-y-6">
      {header}
      <OrchestratorModelPanel organizationId={organizationId} />
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
          <SessionView key={selected.id} session={selected} brands={brands} userId={user?.id ?? null} />
        </>
      ) : null}
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
