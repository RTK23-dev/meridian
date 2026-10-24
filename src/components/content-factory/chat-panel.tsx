import { fileBase64 } from "./file-base64.ts";
import { useRef, useState, type DragEvent } from "react";
import { FileText, Film, Image as ImageIcon, Link2, Paperclip, PlugZap, Search, X } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  ErrorNotice,
  Input,
  SelectInput,
  Textarea,
  toast,
} from "@/components/ui";
import { attachContentFactorySource, postContentFactoryMessage, searchContentFactorySources, uploadContentFactoryFile } from "@/lib/meridian/content-factory/actions";

import {
  ACCEPTED_FILE_LABEL,
  bytesLabel,
  MAX_MESSAGE_CHARS,
  PDF_TEXT_NOTE,
  SCRIPT_ROLES,
  SOURCE_PAGE_LABELS,
  SOURCE_PAGES,
  type Attachment,
  type FilePurpose,
  type ScriptRole,
  type SessionDetail,
  type SourcePage,
  type SourceResult,
} from "@/lib/meridian/content-factory/model";

type BrandOption = { id: string; name: string };
type PendingFile = { key: string; file: File; purpose: FilePurpose };
type FilesState = { status: "ready" } | { status: "not_connected"; reason: string } | null;

const ROLE_LABELS: Record<ScriptRole, string> = { hook: "Hook", setup: "Setup", item: "Item", proof: "Proof", twist: "Twist", payoff: "Payoff", cta: "Call to action" };
/** The file input's accept list. The server checks the bytes again; this only narrows the picker. */
const ACCEPT = "video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp,text/plain,text/markdown,text/csv,application/json,application/pdf,.txt,.md,.markdown,.csv,.json,.pdf";

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ChatPanel({ session, brands, files, onChanged }: { session: SessionDetail; brands: BrandOption[]; files: FilesState; onChanged: () => void }) {
  const draft = session.status === "draft";
  const hasReference = session.messages.some((message) => message.attachments.some((item) => item.kind === "file" && item.purpose === "reference_video"));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat</CardTitle>
        <CardDescription>
          {draft
            ? "Tell the engine what the video is for, attach files from your computer and records from other pages. The engine writes the script from this brief, unless you send script lines of your own. Everything you add is kept with this session."
            : "This session has made its video request. Revisions are not built yet, so start a new session for another version."}
        </CardDescription>
      </CardHeader>
      {session.messages.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-fg-muted">No messages yet. Start with what the video is for and attach the reference video you want it to feel like.</p>
      ) : (
        <ol aria-label="Messages" className="space-y-3">
          {session.messages.map((message) => (
            <li key={message.id} className="rounded-lg border border-border bg-surface-2 p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <span className="font-semibold text-fg">{message.authorName ?? "A former member"}</span>
                <span>{timeLabel(message.createdAt)}</span>
                {message.beatRole ? <Badge variant="info">Script: {ROLE_LABELS[message.beatRole]}</Badge> : <Badge>Instruction</Badge>}
              </div>
              {message.text ? <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p> : null}
              {message.attachments.length > 0 ? <ul className="mt-2 space-y-1.5">{message.attachments.map((item) => <AttachmentRow key={item.id} item={item} />)}</ul> : null}
            </li>
          ))}
        </ol>
      )}
      {draft ? <Composer session={session} brands={brands} files={files} hasReference={hasReference} onChanged={onChanged} /> : null}
    </Card>
  );
}

function AttachmentRow({ item }: { item: Attachment }) {
  if (item.kind === "source") {
    return (
      <li className="flex items-start gap-2 text-sm">
        <Link2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" />
        <span className="min-w-0 break-words"><span className="font-semibold">{SOURCE_PAGE_LABELS[item.page]}:</span> {item.snapshot}</span>
      </li>
    );
  }
  const Icon = item.mediaType.startsWith("video/") ? Film : item.mediaType.startsWith("image/") ? ImageIcon : FileText;
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" />
      <span className="min-w-0 break-words">
        <span className="font-semibold">{item.fileName}</span> · {item.mediaType} · {bytesLabel(item.bytes)}
        {item.purpose === "reference_video" ? <Badge variant="warning" className="ml-2">Reference: analysed only</Badge> : null}
      </span>
    </li>
  );
}

function Composer({ session, brands, files, hasReference, onChanged }: { session: SessionDetail; brands: BrandOption[]; files: FilesState; hasReference: boolean; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"instruction" | ScriptRole>("instruction");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pendingSources, setPendingSources] = useState<SourceResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const isScript = kind !== "instruction";
  const nothingToSend = !text.trim() && pendingFiles.length === 0 && pendingSources.length === 0;
  const scriptWithoutText = isScript && !text.trim();
  const referenceCount = pendingFiles.filter((item) => item.purpose === "reference_video").length + (hasReference ? 1 : 0);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const added = [...list].map((file, index): PendingFile => ({
      key: `${file.name}-${file.size}-${Date.now()}-${index}`,
      file,
      purpose: "material",
    }));
    setPendingFiles((current) => {
      const next = [...current, ...added];
      // The first video becomes the reference when the session has none yet. The person can change it before sending.
      if (!hasReference && !next.some((item) => item.purpose === "reference_video")) {
        const firstVideo = next.find((item) => item.file.type.startsWith("video/"));
        if (firstVideo) firstVideo.purpose = "reference_video";
      }
      return next;
    });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const send = async () => {
    setBusy(true);
    setErrors([]);
    const problems: string[] = [];
    try {
      const { messageId } = await postContentFactoryMessage({ data: { sessionId: session.id, text, beatRole: isScript ? kind : null } });
      // The message is sent, so its text is cleared. An attachment that was not stored stays in the composer, so it is not lost.
      const failedFiles: PendingFile[] = [];
      for (const item of pendingFiles) {
        try {
          const base64 = await fileBase64(item.file);
          const outcome = await uploadContentFactoryFile({ data: { sessionId: session.id, messageId, fileName: item.file.name, purpose: item.purpose, base64 } });
          if (outcome.status !== "stored") {
            problems.push(`${item.file.name}: ${outcome.reason}`);
            failedFiles.push(item);
          }
        } catch (error) {
          problems.push(`${item.file.name}: ${error instanceof Error ? error.message : "it was not stored."}`);
          failedFiles.push(item);
        }
      }
      const failedSources: SourceResult[] = [];
      for (const source of pendingSources) {
        try {
          await attachContentFactorySource({ data: { sessionId: session.id, messageId, brandId: source.brandId, page: source.page, recordId: source.recordId } });
        } catch (error) {
          problems.push(`${source.title}: ${error instanceof Error ? error.message : "it was not attached."}`);
          failedSources.push(source);
        }
      }
      setText("");
      setKind("instruction");
      setPendingFiles(failedFiles);
      setPendingSources(failedSources);
      if (problems.length > 0) {
        setErrors([...problems, "The attachments that failed are still in the composer. Send again to attach them to a new message."]);
        toast.error("The message was sent, but some attachments were not added.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The message was not sent.");
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const disabledReason = nothingToSend ? "Type a message or add an attachment." : scriptWithoutText ? "A script line needs text." : referenceCount > 1 ? "A session uses one reference video. Mark the others as material." : null;

  return (
    <form className="mt-5 space-y-3 border-t border-border pt-5" onSubmit={(event) => { event.preventDefault(); if (!disabledReason) void send(); }}>
      <Textarea label="Message" value={text} maxLength={MAX_MESSAGE_CHARS} onChange={(event) => setText(event.target.value)} placeholder="Make a 30 second reel for our blender with the pacing of the attached video." />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="cf-kind" className="block text-sm font-semibold">This message is</label>
          <SelectInput id="cf-kind" value={kind} onChange={(event) => setKind(event.target.value as "instruction" | ScriptRole)}>
            <option value="instruction">An instruction</option>
            {SCRIPT_ROLES.map((role) => <option key={role} value={role}>A script line: {ROLE_LABELS[role]}</option>)}
          </SelectInput>
        </div>
        <p className="self-end text-xs text-fg-muted">Script lines are optional. Without them, the engine writes the script from your instructions. With them, your lines are the narration, in the order you send them.</p>
      </div>

      <div
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-lg border border-dashed p-4 text-sm ${dragging ? "border-accent bg-accent-soft" : "border-border-strong"}`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" size="md" leftIcon={<Paperclip aria-hidden="true" className="size-4" />} onClick={() => inputRef.current?.click()}>Attach files</Button>
          <SourcePicker sessionId={session.id} brands={brands} defaultBrandId={session.brandId} onPick={(source) => setPendingSources((current) => current.some((item) => item.page === source.page && item.recordId === source.recordId) ? current : [...current, source])} />
          <span className="text-fg-muted">or drop files here</span>
        </div>
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Choose files" onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
        <p className="mt-2 text-xs text-fg-muted">{ACCEPTED_FILE_LABEL}. Files are checked on the server and kept in the brand's Google Drive folder. {PDF_TEXT_NOTE}</p>
        {files && files.status === "not_connected" ? <p className="mt-2 flex items-start gap-2 text-xs text-fg-muted"><PlugZap aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{files.reason}</p> : null}
      </div>

      {pendingFiles.length > 0 ? (
        <ul aria-label="Files to send" className="space-y-2">
          {pendingFiles.map((item) => (
            <li key={item.key} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm">
              <span className="min-w-0 flex-1 break-words font-medium">{item.file.name} · {bytesLabel(item.file.size)}</span>
              <label className="sr-only" htmlFor={`purpose-${item.key}`}>Use of {item.file.name}</label>
              <SelectInput id={`purpose-${item.key}`} className="w-auto py-2 text-sm" value={item.purpose} onChange={(event) => setPendingFiles((current) => current.map((entry) => entry.key === item.key ? { ...entry, purpose: event.target.value as FilePurpose } : entry))}>
                <option value="reference_video">Reference video</option>
                <option value="material">Material</option>
              </SelectInput>
              <Button type="button" variant="quiet" size="sm" aria-label={`Remove ${item.file.name}`} onClick={() => setPendingFiles((current) => current.filter((entry) => entry.key !== item.key))}><X aria-hidden="true" className="size-4" /></Button>
            </li>
          ))}
        </ul>
      ) : null}
      {pendingSources.length > 0 ? (
        <ul aria-label="Records to attach" className="space-y-2">
          {pendingSources.map((source) => (
            <li key={`${source.page}-${source.recordId}`} className="flex items-start gap-2 rounded-md border border-border p-2 text-sm">
              <Link2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 break-words"><span className="font-semibold">{SOURCE_PAGE_LABELS[source.page]}: {source.title}</span> · {source.snapshot}</span>
              <Button type="button" variant="quiet" size="sm" aria-label={`Remove ${source.title}`} onClick={() => setPendingSources((current) => current.filter((item) => !(item.page === source.page && item.recordId === source.recordId)))}><X aria-hidden="true" className="size-4" /></Button>
            </li>
          ))}
        </ul>
      ) : null}
      {pendingFiles.some((item) => item.purpose === "reference_video") || hasReference ? (
        <p className="text-xs text-fg-muted">The reference video is analysed only. Its footage, words, voice and music never enter the new video, and the engine deletes the source media after the analysis.</p>
      ) : null}
      {errors.length > 0 ? <div className="space-y-1">{errors.map((error) => <ErrorNotice key={error}>{error}</ErrorNotice>)}</div> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="md" loading={busy} disabled={busy || disabledReason !== null} aria-describedby={disabledReason ? "cf-send-reason" : undefined}>Send</Button>
        {disabledReason ? <p id="cf-send-reason" className="text-sm text-fg-muted">{disabledReason}</p> : null}
      </div>
    </form>
  );
}

function SourcePicker({ sessionId, brands, defaultBrandId, onPick }: { sessionId: string; brands: BrandOption[]; defaultBrandId: string | null; onPick: (source: SourceResult) => void }) {
  const [open, setOpen] = useState(false);
  const [brandId, setBrandId] = useState(defaultBrandId ?? brands[0]?.id ?? "");
  const [page, setPage] = useState<SourcePage>("product");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SourceResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (!brandId) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await searchContentFactorySources({ data: { sessionId, brandId, page, query } }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The search did not run.");
      setResults(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="secondary" size="md" leftIcon={<Link2 aria-hidden="true" className="size-4" />} onClick={() => setOpen(true)}>Attach from Meridian</Button>
      <DialogContent>
        <DialogTitle>Attach a Meridian record</DialogTitle>
        <DialogDescription>Records are read only. A short snapshot is shown in the chat and passed to the engine as context.</DialogDescription>
        {brands.length === 0 ? (
          <p className="text-sm text-fg-muted">This workspace has no brands yet, so there are no records to attach.</p>
        ) : (
          <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void search(); }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="cf-source-brand" className="block text-sm font-semibold">Brand</label>
                <SelectInput id="cf-source-brand" value={brandId} onChange={(event) => { setBrandId(event.target.value); setResults(null); }}>
                  {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
                </SelectInput>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="cf-source-page" className="block text-sm font-semibold">Page</label>
                <SelectInput id="cf-source-page" value={page} onChange={(event) => { setPage(event.target.value as SourcePage); setResults(null); }}>
                  {SOURCE_PAGES.map((item) => <option key={item} value={item}>{SOURCE_PAGE_LABELS[item]}</option>)}
                </SelectInput>
              </div>
            </div>
            <Input label="Search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Leave empty to list the newest" />
            <Button type="submit" size="md" variant="secondary" loading={busy} leftIcon={<Search aria-hidden="true" className="size-4" />}>Search</Button>
            {error ? <ErrorNotice>{error}</ErrorNotice> : null}
            {results && results.length === 0 ? <p className="text-sm text-fg-muted">Nothing on {SOURCE_PAGE_LABELS[page]} matches for this brand.</p> : null}
            {results && results.length > 0 ? (
              <ul className="max-h-72 space-y-2 overflow-y-auto">
                {results.map((result) => (
                  <li key={result.recordId} className="flex items-start gap-2 rounded-md border border-border p-2 text-sm">
                    <span className="min-w-0 flex-1 break-words"><span className="font-semibold">{result.title}</span><span className="block text-xs text-fg-muted">{result.snapshot}</span></span>
                    <DialogClose asChild><Button type="button" size="sm" variant="secondary" onClick={() => onPick(result)}>Add</Button></DialogClose>
                  </li>
                ))}
              </ul>
            ) : null}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
