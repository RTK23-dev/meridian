import { useState, type DragEvent } from "react";
import { Button, Field, Notice, TextArea, errorText } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { BrainKey } from "@/lib/meridian/brain";
import { storeMaterial, suggestFromDocument } from "@/lib/meridian/machine";
import { useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { SuggestionList } from "./suggestion-list";
import { documentProblem, readFileAsBase64, summariseUpload, type UploadSummary } from "./uploads";

type StoreVars = { filename: string; mime: string; text: string; base64: string };

/**
 * "Suggest from document": a dropped or chosen file is stored as untrusted text, then the text model
 * proposes brain edits from it. Proposals wait in the suggestion list until someone accepts them.
 */
export function SourceMaterial({ brandId, canEdit, saved, formDirty }: {
  brandId: string;
  canEdit: boolean;
  saved: Partial<Record<BrainKey, string>>;
  formDirty: boolean;
}) {
  const [status, setStatus] = useState<UploadSummary | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pasted, setPasted] = useState("");
  const [working, setWorking] = useState(false);
  const storeMutation = useScopedMutation({
    mutationKey: ["mutation", "brand.material", brandId],
    mutationFn: (vars: StoreVars) => storeMaterial({ data: { brandId, ...vars } }),
    // Stored material adds source documents, which the brand overview counts and the suggestion list reads.
    invalidate: () => [qk.assets(brandId), qk.machine(brandId), qk.market(brandId)],
  });
  const suggestMutation = useScopedMutation({
    mutationKey: ["mutation", "brain.suggest", brandId],
    mutationFn: (documentId: string) => suggestFromDocument({ data: { brandId, documentId } }),
    invalidate: () => [qk.market(brandId)],
  });

  /** Stores the text, then asks for suggestions. Returns true only when the text was stored. */
  async function storeAndSuggest(vars: StoreVars, notice?: string): Promise<boolean> {
    setStatus(null);
    setWorking(true);
    setStage("Storing the text…");
    try {
      const stored = await storeMutation.mutateAsync(vars);
      if (stored.status === "failed") {
        setStatus(summariseUpload({ status: "failed", detail: stored.detail }, null));
        return false;
      }
      setStage("Asking the text model for suggestions…");
      const suggested = await suggestMutation.mutateAsync(stored.id).catch((error: unknown) => ({ status: "failed" as const, message: errorText(error) }));
      const summary = summariseUpload({ status: "stored", detail: stored.detail, droppedLines: stored.droppedLines }, suggested);
      setStatus(notice ? { ...summary, message: `${notice} ${summary.message}` } : summary);
      return true;
    } catch (error) {
      setStatus({ tone: "danger", message: errorText(error) });
      return false;
    } finally {
      setWorking(false);
      setStage(null);
    }
  }

  async function chooseFile(file: File, moreThanOne: boolean) {
    const problem = documentProblem(file);
    if (problem) {
      setStatus({ tone: "danger", message: problem });
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      await storeAndSuggest(
        { filename: file.name, mime: file.type || "application/octet-stream", text: "", base64 },
        moreThanOne ? "Only the first file was used. Drop one file at a time." : undefined,
      );
    } catch (error) {
      setStatus({ tone: "danger", message: errorText(error) });
    }
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!canEdit || working) return;
    event.preventDefault();
    setDragging(true);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!canEdit || working) return;
    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;
    void chooseFile(files[0], files.length > 1);
  }

  async function storePasted() {
    if (!pasted.trim()) {
      setStatus({ tone: "danger", message: "Paste some text first." });
      return;
    }
    const stored = await storeAndSuggest({ filename: "pasted.txt", mime: "text/plain", text: pasted, base64: "" });
    if (stored) setPasted("");
  }

  return <div className="space-y-5 rounded-lg border border-border bg-surface p-5">
    <div className="space-y-1">
      <h3 className="text-base font-semibold">Suggest from document</h3>
      <p className="text-sm text-fg-muted">Plain text, Markdown, DOCX, and PDF text can be stored. Instruction-like lines are dropped. An image-only PDF fails. The file is stored as untrusted text. It does not change the brain.</p>
    </div>

    {canEdit ? (
      <div
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        aria-describedby="material-drop-hint"
        className={cn("space-y-3 rounded-lg border-2 border-dashed p-5", dragging ? "border-accent bg-accent-soft" : "border-border-strong")}
      >
        <p className="font-semibold">{dragging ? "Release to store and suggest from this file" : "Drop a document here"}</p>
        <p id="material-drop-hint" className="text-sm text-fg-muted">Suggestions wait in the list below. Nothing changes until you accept one.</p>
        <label className="block space-y-2 text-sm font-semibold">
          Or choose a file
          <input
            className="block min-h-11 w-full min-w-0 text-sm font-normal"
            type="file"
            accept=".txt,.md,.docx,.pdf,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            disabled={working}
            onChange={(event) => {
              const count = event.target.files?.length ?? 0;
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void chooseFile(file, count > 1);
            }}
          />
        </label>
      </div>
    ) : null}

    {stage ? <p role="status" aria-live="polite" className="text-sm text-fg-muted">{stage}</p> : null}
    {status ? (
      status.tone === "danger"
        ? <Notice>{status.message}</Notice>
        : <p role="status" aria-live="polite" className="text-sm text-fg">{status.message}</p>
    ) : null}

    {canEdit ? (
      <div className="space-y-3">
        <Field label="Or paste text" hint="Pasted text is stored the same way as a file.">
          <TextArea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder="Paste brand or product text"
            disabled={working}
          />
        </Field>
        <Button type="button" variant="secondary" disabled={working} onClick={() => void storePasted()}>Store pasted text and suggest</Button>
      </div>
    ) : null}

    <SuggestionList brandId={brandId} canEdit={canEdit} saved={saved} formDirty={formDirty} />
  </div>;
}
