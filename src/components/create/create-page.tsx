import { lazy, Suspense, useState } from "react";
import { useWorkspace } from "@/components/workspace";
import { EmptyState, ErrorNotice, ScreenSkeleton } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { createContentFactorySession, getContentFactorySession, postContentFactoryMessage } from "@/lib/meridian/content-factory/actions";
import type { Message } from "@/lib/meridian/content-factory/model";
import { CreateComposer, type ModelOption } from "./create-composer";
import { CREATE_MODE_COPY, sendBlock, titleFor, type CreateMode } from "./create-model";
import { CreateThread } from "./create-thread";

// Studio is the existing controls page. It loads the first time Studio is chosen, so Orchestrator stays light.
const Studio = lazy(() => import("@/components/content-factory/sections/studio").then((module) => ({ default: module.Studio })));

/** The models a draft can use. Only Auto is offered until the workspace has connected a model, and the list then grows from its providers. */
const MODELS: ModelOption[] = [{ value: "auto", label: "Auto" }];

/**
 * The Create page: one place to make something. Orchestrator takes what you write, plans the piece and saves it as a draft in the Content
 * chat. Studio shows the controls on this page instead. Sending never starts a run, so nothing is generated or spent until a person starts
 * one from the draft.
 */
export function CreatePage() {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const canAdmin = hasRole(workspace?.active?.role ?? "viewer", "admin");
  const brands = workspace?.brands ?? [];

  const [mode, setMode] = useState<CreateMode>("orchestrator");
  const [brandId, setBrandId] = useState("");
  const [model, setModel] = useState("auto");
  const [text, setText] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const block = organizationId ? sendBlock({ text, mode, canAdmin, busy }) : "Open a workspace first.";
  const canSend = block === null;
  // The reason is shown once there is something to act on. An empty box only shows the mode's own hint.
  const hint = block !== null && (mode === "studio" || !canAdmin || busy || text.trim() !== "") ? block : CREATE_MODE_COPY[mode].hint;

  function chooseBrand(next: string) {
    // A draft belongs to one brand, so a new brand starts a new draft.
    setBrandId(next);
    setSessionId(null);
    setMessages([]);
    setError(null);
  }

  function startOver() {
    setSessionId(null);
    setMessages([]);
    setText("");
    setError(null);
  }

  async function send() {
    if (!canSend) return;
    const body = text.trim();
    setBusy(true);
    setError(null);
    try {
      let id = sessionId;
      if (id === null) {
        const created = await createContentFactorySession({ data: { organizationId, brandId: brandId || null, title: titleFor(body) } });
        id = created.id;
        setSessionId(id);
      }
      await postContentFactoryMessage({ data: { sessionId: id, text: body, beatRole: null } });
      const detail = await getContentFactorySession({ data: { sessionId: id } });
      setMessages(detail.messages);
      setText("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Nothing was saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-9rem)] w-full max-w-3xl flex-col">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="page-title">Create</h1>
          <p className="text-sm text-fg-muted">Say what to make, and choose how it runs.</p>
        </div>
        <div className="flex items-end gap-3">
          <label className="flex flex-col gap-1 text-caption font-semibold uppercase tracking-wide text-fg-muted">
            Brand
            <select
              value={brandId}
              onChange={(event) => chooseBrand(event.target.value)}
              className="min-h-9 min-w-40 border border-border-strong bg-transparent px-2 text-sm font-normal normal-case tracking-normal text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <option value="">No brand</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>{brand.name}</option>
              ))}
            </select>
          </label>
          {sessionId !== null ? (
            <button type="button" onClick={startOver} className="min-h-9 px-2 text-sm text-fg-muted underline underline-offset-4 hover:text-fg-primary">New chat</button>
          ) : null}
        </div>
      </header>

      <div className="flex-1 pb-6">
        {mode === "studio" ? (
          brandId ? (
            <Suspense fallback={<ScreenSkeleton label="Loading Studio" shape="cards" />}>
              <div className="pt-4"><Studio brandId={brandId} /></div>
            </Suspense>
          ) : (
            <div className="pt-4">
              <EmptyState title="Pick a brand for Studio" reason="Studio sets the controls for one brand, so choose a brand above first." />
            </div>
          )
        ) : (
          <>
            <CreateThread messages={messages} onSuggest={setText} />
            {error !== null ? <div className="pt-4"><ErrorNotice>{error}</ErrorNotice></div> : null}
          </>
        )}
      </div>

      <CreateComposer
        text={text}
        onText={setText}
        mode={mode}
        onMode={setMode}
        models={MODELS}
        model={model}
        onModel={setModel}
        canSend={canSend}
        hint={hint}
        busy={busy}
        onSend={() => void send()}
      />
    </div>
  );
}
