import { lazy, Suspense, useEffect, useState } from "react";
import { useWorkspace } from "@/components/workspace";
import { fileBase64 } from "@/components/content-factory/file-base64";
import { EmptyState, ErrorNotice, ScreenSkeleton } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { createContentFactorySession, getContentFactorySession, postContentFactoryMessage, uploadContentFactoryFile } from "@/lib/meridian/content-factory/actions";
import type { Message } from "@/lib/meridian/content-factory/model";
import { CreateAttachSheet } from "./create-attach-sheet";
import { CreateComposer, type ComposerFile, type ModelOption } from "./create-composer";
import { CREATE_MODE_COPY, fileProblem, purposeFor, ruleFor, sendBlock, titleFor, type CreateMode } from "./create-model";
import { CreateScripts } from "./create-scripts";
import { CreateThread } from "./create-thread";

// Studio is the existing controls page. It loads the first time Studio is chosen, so Orchestrator stays light.
const Studio = lazy(() => import("@/components/content-factory/sections/studio").then((module) => ({ default: module.Studio })));

/** The models a draft can use. Only Auto is offered until the workspace has connected a model, and the list then grows from its providers. */
const MODELS: ModelOption[] = [{ value: "auto", label: "Auto" }];

type PendingFile = { id: string; file: File; purpose: "reference_video" | "material" };

/**
 * The Create page: one place to make something. Orchestrator takes what you write and the files you add, and saves them as a draft in the
 * Content chat. Studio shows the controls on this page instead. Sending never starts a run, so nothing is generated or spent until a person
 * starts one from the draft.
 */
export function CreatePage({ draftId = null, onDraft }: { draftId?: string | null; onDraft?: (draftId: string | null) => void } = {}) {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const canAdmin = hasRole(workspace?.active?.role ?? "viewer", "admin");
  const brands = workspace?.brands ?? [];

  const [mode, setMode] = useState<CreateMode>("orchestrator");
  const [brandId, setBrandId] = useState("");
  const [model, setModel] = useState("auto");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const [draftLanguage, setDraftLanguage] = useState<string | null>(null);

  // A draft named in the address is read back, so a reload or a shared link returns to it and its scripts.
  useEffect(() => {
    if (!draftId || draftId === sessionId) return;
    let live = true;
    getContentFactorySession({ data: { sessionId: draftId } })
      .then((detail) => {
        if (!live) return;
        setSessionId(detail.id);
        setMessages(detail.messages);
        setBrandId(detail.brandId ?? "");
        setDraftLanguage(detail.settings.language);
      })
      .catch((failure: unknown) => {
        if (!live) return;
        setProblems([failure instanceof Error ? failure.message : "That draft could not be opened."]);
        onDraft?.(null);
      });
    return () => {
      live = false;
    };
    // The draft is read once per id it names; the session state follows from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  const block = organizationId ? sendBlock({ text, mode, canAdmin, busy }) : "Open a workspace first.";
  const canSend = block === null;
  // The reason is shown once there is something to act on. An empty box only shows the mode's own hint.
  const hint = block !== null && (mode === "studio" || !canAdmin || busy || text.trim() !== "") ? block : CREATE_MODE_COPY[mode].hint;

  const composerFiles: ComposerFile[] = files.map(({ id, file, purpose }) => ({ id, name: file.name, purpose, kind: ruleFor(file)?.kind ?? "document" }));

  function chooseBrand(next: string) {
    // A draft belongs to one brand, so a new brand starts a new draft.
    setBrandId(next);
    setSessionId(null);
    setMessages([]);
    setProblems([]);
    onDraft?.(null);
  }

  function startOver() {
    setSessionId(null);
    setMessages([]);
    setText("");
    setFiles([]);
    setProblems([]);
    onDraft?.(null);
  }

  function addFiles(picked: File[]) {
    const refused: string[] = [];
    const kept: PendingFile[] = [];
    for (const file of picked) {
      const problem = fileProblem(file);
      if (problem) refused.push(problem);
      else kept.push({ id: `${file.name}-${file.size}-${file.lastModified}-${kept.length}`, file, purpose: purposeFor(file) });
    }
    if (kept.length > 0) setFiles((current) => [...current, ...kept]);
    setProblems(refused);
  }

  function togglePurpose(id: string) {
    setFiles((current) => current.map((item) => (item.id === id ? { ...item, purpose: item.purpose === "reference_video" ? "material" : "reference_video" } : item)));
  }

  async function send() {
    if (!canSend) return;
    const body = text.trim();
    setBusy(true);
    setProblems([]);
    try {
      let id = sessionId;
      if (id === null) {
        const created = await createContentFactorySession({ data: { organizationId, brandId: brandId || null, title: titleFor(body) } });
        id = created.id;
        setSessionId(id);
        onDraft?.(id);
      }
      const { messageId } = await postContentFactoryMessage({ data: { sessionId: id, text: body, beatRole: null } });
      // The message is saved, so its text is cleared. A file that was not stored stays in the composer, so it is not lost.
      const notStored: PendingFile[] = [];
      const reasons: string[] = [];
      for (const item of files) {
        try {
          const base64 = await fileBase64(item.file);
          const outcome = await uploadContentFactoryFile({ data: { sessionId: id, messageId, fileName: item.file.name, purpose: item.purpose, base64 } });
          if (outcome.status !== "stored") {
            reasons.push(`${item.file.name}: ${outcome.reason}`);
            notStored.push(item);
          }
        } catch (failure) {
          reasons.push(`${item.file.name}: ${failure instanceof Error ? failure.message : "it was not stored."}`);
          notStored.push(item);
        }
      }
      const detail = await getContentFactorySession({ data: { sessionId: id } });
      setMessages(detail.messages);
      setText("");
      setFiles(notStored);
      setProblems(reasons);
    } catch (failure) {
      setProblems([failure instanceof Error ? failure.message : "Nothing was saved. Try again."]);
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
              className="min-h-9 min-w-40 rounded-sharp border border-border-strong bg-transparent px-3 text-sm font-normal normal-case tracking-normal text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
            {sessionId !== null && canAdmin ? <CreateScripts sessionId={sessionId} canAdmin={canAdmin} language={draftLanguage} onMessages={setMessages} /> : null}
            {problems.length > 0 ? (
              <ul className="space-y-2 pt-4" aria-label="Problems">
                {problems.map((problem) => (
                  <li key={problem}><ErrorNotice>{problem}</ErrorNotice></li>
                ))}
              </ul>
            ) : null}
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
        files={composerFiles}
        onTogglePurpose={togglePurpose}
        onRemoveFile={(id) => setFiles((current) => current.filter((item) => item.id !== id))}
        onAttach={() => setAttachOpen(true)}
        canSend={canSend}
        hint={hint}
        busy={busy}
        onSend={() => void send()}
      />

      <CreateAttachSheet open={attachOpen} onOpenChange={setAttachOpen} onFiles={addFiles} />
    </div>
  );
}
