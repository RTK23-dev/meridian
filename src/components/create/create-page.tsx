import { lazy, Suspense, useEffect, useState } from "react";
import { useWorkspace } from "@/components/workspace";
import { fileBase64 } from "@/components/content-factory/file-base64";
import { EmptyState, ErrorNotice, ScreenSkeleton } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { ClaudeCodeVideo } from "@/components/settings/claude-code-video";
import { useProviderSettingsQuery } from "@/lib/query/hooks";
import { readLocal, writeLocal } from "@/lib/navigation/local-storage";
import { createContentFactorySession, getContentFactorySession, postContentFactoryMessage, uploadContentFactoryFile } from "@/lib/meridian/content-factory/actions";
import type { FilePurpose, Message } from "@/lib/meridian/content-factory/model";
import { CreateAttachSheet } from "./create-attach-sheet";
import { CreateComposer, type ComposerFile } from "./create-composer";
import { CREATE_WAY_KEY, defaultWay, fileProblem, purposeFor, referencePurposeOf, ruleFor, sendBlock, textModelStateOf, titleFor, togglePurposeOf, type CreateMode, type CreateWay } from "./create-model";
import { CreateScripts } from "./create-scripts";
import { CreateThread } from "./create-thread";
import { CreateBatchWay, CreateWays } from "./create-ways";

// Studio is the existing controls page. It loads the first time Studio is chosen, so Orchestrator stays light.
const Studio = lazy(() => import("@/components/content-factory/sections/studio").then((module) => ({ default: module.Studio })));

type PendingFile = { id: string; file: File; purpose: FilePurpose };

/**
 * The Create page: the one front door for making something. Empty, it first asks how: free with Claude Code on the person's own computer,
 * with Meridian and the workspace's keys, or many variations at once on a brand's Batch section. With Meridian, in both modes what you write and the files you add are saved as a draft in the Content
 * chat. Orchestrator then offers Meridian's plan (the scripts); Studio shows its five phases, which the person drives one by one, on a
 * canvas. Sending never starts a run, so nothing is generated or spent until a person starts one. The models each task uses are chosen
 * in Settings, reached from the mode menu.
 */
export function CreatePage({
  draftId = null,
  onDraft,
  way: linkedWay = null,
  onWayLink,
}: { draftId?: string | null; onDraft?: (draftId: string | null) => void; way?: CreateWay | null; onWayLink?: () => void } = {}) {
  const { data: workspace } = useWorkspace();
  const organizationId = workspace?.active?.id ?? "";
  const canAdmin = hasRole(workspace?.active?.role ?? "viewer", "admin");
  const canMake = hasRole(workspace?.active?.role ?? "viewer", "member");
  const brands = workspace?.brands ?? [];

  // The way to make it. The person's last choice in this browser is read after the page mounts (storage is not there on the server); until
  // then, and while the key state loads, nothing is chosen. A way named in the address wins once and is remembered.
  const providers = useProviderSettingsQuery(organizationId);
  const [storedWay, setStoredWay] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (linkedWay) {
      writeLocal(CREATE_WAY_KEY, linkedWay);
      setStoredWay(linkedWay);
      onWayLink?.();
      return;
    }
    setStoredWay(readLocal(CREATE_WAY_KEY));
    // The address is read once, when the page opens with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedWay]);
  const openRouter = (providers.data as Record<string, { credentialState?: string } | undefined> | undefined)?.openrouter;
  const textModel = textModelStateOf({ loading: !organizationId || providers.isPending, failed: providers.isError, credentialState: openRouter?.credentialState });
  const way: CreateWay | null = storedWay === undefined ? null : defaultWay({ stored: storedWay, textModel });
  const chooseWay = (next: CreateWay) => {
    writeLocal(CREATE_WAY_KEY, next);
    setStoredWay(next);
  };

  const [mode, setMode] = useState<CreateMode>("orchestrator");
  const [brandId, setBrandId] = useState("");
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
  // Only a reason the person cannot act on from the box is shown as text; the rest is on Send's tooltip and read to a screen reader.
  const notice = !organizationId ? "Open a workspace first." : !canAdmin ? "Only a workspace admin can start a draft." : null;

  const composerFiles: ComposerFile[] = files.map(({ id, file, purpose }) => {
    const kind = ruleFor(file)?.kind ?? "document";
    return { id, name: file.name, kind, reference: referencePurposeOf(kind) === null ? null : purpose !== "material" };
  });

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
    setFiles((current) => current.map((item) => (item.id === id ? { ...item, purpose: togglePurposeOf(ruleFor(item.file)?.kind ?? "document", item.purpose) } : item)));
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

  // A starting point fills the box and moves the cursor there, so the person sees where it went and can edit or send it.
  const suggest = (value: string) => {
    setText(value);
    requestAnimationFrame(() => document.getElementById("create-message")?.focus());
  };

  // The choice of way is offered on the empty page. An open draft is a Meridian draft, so it shows the composer and its scripts.
  const choosing = sessionId === null && !draftId;
  const shownWay: CreateWay | null = choosing ? way : "meridian";

  return (
    // On a phone the page reaches into <main>'s bottom padding (-mb-6), so the composer docks on the bottom bar at every scroll position.
    <div className="mx-auto -mb-6 flex min-h-[calc(100dvh-9rem)] w-full max-w-3xl flex-col lg:mb-0">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="page-title">Create</h1>
          <p className="text-sm text-fg-muted">Say what to make, and choose how it is made.</p>
        </div>
        <div className="flex items-end gap-3">
          {shownWay === "claude_code" ? null : <label className="flex flex-col gap-1 text-caption font-semibold uppercase tracking-wide text-fg-muted">
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
          </label>}
          {sessionId !== null ? (
            <button type="button" onClick={startOver} className="min-h-9 px-2 text-sm text-fg-muted underline underline-offset-4 hover:text-fg-primary">New chat</button>
          ) : null}
        </div>
      </header>

      {choosing ? <CreateWays way={way} onWay={chooseWay} /> : null}

      {shownWay === "claude_code" ? (
        <div className="flex-1 pb-6 pt-6">
          <ClaudeCodeVideo organizationId={organizationId} canMake={canMake} canAdmin={canAdmin} />
        </div>
      ) : shownWay === "batch" ? (
        <div className="flex-1 pb-6">
          <CreateBatchWay brandId={brandId} brands={brands} canAdmin={canAdmin} />
        </div>
      ) : shownWay === null ? (
        <div className="flex-1" />
      ) : (
      <>
      <div className="flex-1 pb-6">
        {mode === "studio" ? (
          <>
            {/* The request typed here is saved as the draft, as in Orchestrator, and stays in view above the phases. */}
            {messages.length > 0 ? <CreateThread messages={messages} onSuggest={suggest} /> : null}
            {brandId ? (
              <Suspense fallback={<ScreenSkeleton label="Loading Studio" shape="cards" />}>
                <section aria-label="Studio canvas" className="canvas-grid -mx-4 mt-4 px-4 py-5 sm:mx-0 sm:rounded-sharp sm:border sm:border-hairline sm:px-5">
                  <Studio brandId={brandId} embedded />
                </section>
              </Suspense>
            ) : (
              <div className="pt-4">
                <EmptyState title="Setting each step starts from a brand's research" reason="The steps begin with a brand's opportunities, so choose a brand above. To make a video without a brand, choose Meridian plans it: it needs none." />
              </div>
            )}
          </>
        ) : (
          <>
            <CreateThread messages={messages} onSuggest={suggest} onFreeWay={() => chooseWay("claude_code")} />
            {sessionId !== null && canAdmin ? <CreateScripts sessionId={sessionId} canAdmin={canAdmin} language={draftLanguage} onMessages={setMessages} /> : null}
          </>
        )}
        {problems.length > 0 ? (
          <ul className="space-y-2 pt-4" aria-label="Problems">
            {problems.map((problem) => (
              <li key={problem}><ErrorNotice>{problem}</ErrorNotice></li>
            ))}
          </ul>
        ) : null}
      </div>

      <CreateComposer
        text={text}
        onText={setText}
        mode={mode}
        onMode={setMode}
        files={composerFiles}
        onTogglePurpose={togglePurpose}
        onRemoveFile={(id) => setFiles((current) => current.filter((item) => item.id !== id))}
        onAttach={() => setAttachOpen(true)}
        canSend={canSend}
        blockReason={block}
        notice={notice}
        busy={busy}
        onSend={() => void send()}
      />
      </>
      )}

      <CreateAttachSheet open={attachOpen} onOpenChange={setAttachOpen} onFiles={addFiles} />
    </div>
  );
}
