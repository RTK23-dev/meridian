import { useEffect, useState } from "react";
import { Button, ErrorState, Notice, errorText } from "@/components/ui";
import { uploadLogo } from "@/lib/meridian/machine";
import { useAssetsQuery, useScopedMutation } from "@/lib/query/hooks";
import { qk } from "@/lib/query/keys";
import { formatFileSize, readFileAsBase64, validateLogoFile } from "./uploads";

type Selected = { file: File; url: string };

/** Shows the stored logo and a preview of the chosen file. Nothing is uploaded until Save logo. */
export function LogoUploader({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const assetsQuery = useAssetsQuery(brandId);
  const stored = assetsQuery.data?.logos[0] ?? null;
  const [selected, setSelected] = useState<Selected | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const uploadLogoMutation = useScopedMutation({
    mutationKey: ["mutation", "brand.logo", brandId],
    mutationFn: (base64: string) => uploadLogo({ data: { brandId, base64 } }),
    invalidate: () => [qk.assets(brandId)],
    onSuccess: (saved) => {
      setNote(saved.status === "stored" ? "Logo stored." : saved.detail);
      if (saved.status === "stored") clearSelection();
    },
  });

  // Release the preview URL when the selection changes or the screen closes.
  useEffect(() => {
    const current = selected;
    return () => {
      if (current) URL.revokeObjectURL(current.url);
    };
  }, [selected]);

  function clearSelection() {
    setSelected(null);
    setProblem(null);
    setInputKey((key) => key + 1);
  }

  function choose(file: File | undefined) {
    setNote(null);
    if (!file) {
      clearSelection();
      return;
    }
    const error = validateLogoFile(file);
    setProblem(error);
    setSelected(error ? null : { file, url: URL.createObjectURL(file) });
  }

  async function save() {
    if (!selected) return;
    try {
      const base64 = await readFileAsBase64(selected.file);
      await uploadLogoMutation.mutateAsync(base64).catch(() => undefined);
    } catch (error) {
      setProblem(errorText(error));
    }
  }

  return <section aria-labelledby="brain-logo-title" className="space-y-4 rounded-lg border border-border bg-surface p-5">
    <div className="space-y-1">
      <h3 id="brain-logo-title" className="text-base font-semibold">Logo</h3>
      <p id="brain-logo-hint" className="text-sm text-fg-muted">PNG, JPEG, or WEBP, under 800 KB. It is checked from the file bytes and stored with this brand. There is no separate file store.</p>
    </div>
    {assetsQuery.isError ? <ErrorState message={errorText(assetsQuery.error)} onRetry={() => void assetsQuery.refetch()} /> : null}

    <div className="flex flex-wrap items-start gap-6">
      <div className="space-y-2">
        <p className="text-sm font-semibold">Stored</p>
        {stored ? (
          <img src={`data:${stored.mime};base64,${stored.body}`} alt="Stored logo" className="h-16 w-auto rounded-md border border-border bg-bg object-contain p-2" />
        ) : assetsQuery.isError ? null : (
          <p className="text-sm text-fg-muted">No logo stored.</p>
        )}
      </div>
      {selected ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Selected</p>
          <img src={selected.url} alt={`Preview of ${selected.file.name}`} className="h-16 w-auto rounded-md border border-border bg-bg object-contain p-2" />
          <p className="break-all text-xs text-fg-muted">{selected.file.name}, {formatFileSize(selected.file.size)}</p>
        </div>
      ) : null}
    </div>

    {canEdit ? (
      <div className="space-y-3">
        <label className="block space-y-2 text-sm font-semibold">
          Choose a logo file
          <input
            key={inputKey}
            className="block min-h-11 w-full min-w-0 text-sm font-normal"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-describedby="brain-logo-hint brain-logo-problem"
            disabled={uploadLogoMutation.isPending}
            onChange={(event) => choose(event.target.files?.[0])}
          />
        </label>
        {problem ? <p id="brain-logo-problem" role="alert" className="text-sm text-danger">{problem}</p> : null}
        {selected ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={uploadLogoMutation.isPending} onClick={() => void save()}>
              {uploadLogoMutation.isPending ? "Saving logo…" : "Save logo"}
            </Button>
            <Button type="button" variant="secondary" disabled={uploadLogoMutation.isPending} onClick={clearSelection}>Cancel</Button>
          </div>
        ) : null}
      </div>
    ) : null}
    {note ? <p role="status" className="text-sm text-fg-muted">{note}</p> : null}
    {uploadLogoMutation.error ? <Notice>{errorText(uploadLogoMutation.error)}</Notice> : null}
  </section>;
}
