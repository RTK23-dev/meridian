import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed, useBusy } from "@/components/gate";
import { Button, Field, Notice, Panel, SelectInput, TextArea } from "@/components/ui";
import { errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import { getBrand, saveBrain, type BrandDetail } from "@/lib/meridian/api";
import { listBrandAssets, storeMaterial, uploadLogo } from "@/lib/meridian/machine";
import {
  AUTOMATION_LEVELS,
  BRAIN_FIELDS,
  emptyBrain,
  provenanceLabel,
  type BrainValues,
} from "@/lib/meridian/brain";

export const Route = createFileRoute("/brands/$brandId/brain")({ component: BrainPage });

function BrainPage() {
  const { brandId } = Route.useParams();
  return (
    <Authed>
      <BrainEditor brandId={brandId} />
    </Authed>
  );
}

function BrainEditor({ brandId }: { brandId: string }) {
  const [detail, setDetail] = useState<BrandDetail | null>(null);
  const [brain, setBrain] = useState<BrainValues>(emptyBrain());
  const [error, setError] = useState<string | null>(null);
  const { pending, error: saveError, run } = useBusy();

  useEffect(() => {
    let cancelled = false;
    getBrand({ data: { brandId } })
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setBrain(next.brain);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  if (error) return <Notice>{error}</Notice>;
  if (!detail) return <p className="text-muted">Loading the brand brain…</p>;
  const canEdit = hasRole(detail.identity.role, "member");
  const groups = [...new Set(BRAIN_FIELDS.map((field) => field.group))];

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await saveBrain({ data: { brandId, ...brain } });
      const next = await getBrand({ data: { brandId } });
      setDetail(next);
      setBrain(next.brain);
    });
  }

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <form onSubmit={submit} className="space-y-8">
      <div className="space-y-2">
        <Link to="/brands/$brandId" params={{ brandId }} className="text-sm text-muted">
          {detail.identity.name}
        </Link>
        <h1 className="font-display text-4xl">Brand brain</h1>
        <p className="max-w-2xl text-muted">
          This is the record later decisions must use. Saving never silently replaces a field you did not change.
          Page suggestions, when a model is configured, stay pending until you accept them.
        </p>
      </div>
      {groups.map((group) => (
        <section key={group} className="space-y-4">
          <h2 className="font-display text-2xl">{group}</h2>
          <div className="grid gap-4">
            {BRAIN_FIELDS.filter((field) => field.group === group).map((field) => {
              const source = detail.provenance[field.key];
              return (
                <Field
                  key={field.key}
                  label={field.label}
                  hint={brain[field.key].trim() && source ? provenanceLabel(source) : "Empty. Not inferred."}
                >
                  <TextArea
                    value={brain[field.key]}
                    disabled={!canEdit}
                    onChange={(event) =>
                      setBrain((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                </Field>
              );
            })}
          </div>
        </section>
      ))}
      <Field
        label="Automation preference"
        hint="Stored only. Nothing is published or approved because this preference is set."
      >
        <SelectInput
          value={brain.automationLevel}
          disabled={!canEdit}
          onChange={(event) =>
            setBrain((current) => ({
              ...current,
              automationLevel: event.target.value as BrainValues["automationLevel"],
            }))
          }
        >
          {AUTOMATION_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </SelectInput>
      </Field>
      {saveError ? <Notice>{saveError}</Notice> : null}
      {canEdit ? <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save brain"}</Button> : null}
      <Panel>
        <h2 className="font-display text-xl">Versions</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {detail.versions.map((version) => (
            <li key={version.version} className="flex justify-between gap-3">
              <span>Version {version.version} · {version.note}</span>
              <span className="text-muted">{version.createdAt.slice(0, 16).replace("T", " ")}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </form>
      <Materials brandId={brandId} canEdit={canEdit} />
    </div>
  );
}

function Materials({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const [logos, setLogos] = useState<{ id: string; mime: string; body: string }[]>([]);
  const { pending, error, run } = useBusy();

  useEffect(() => {
    let cancelled = false;
    listBrandAssets({ data: { brandId } })
      .then((next) => {
        if (!cancelled) setLogos(next.logos);
      })
      .catch(() => {
        if (!cancelled) setLogos([]);
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  return (
    <div className="space-y-4">
      <Panel>
        <h2 className="font-display text-2xl">Logo</h2>
        <p className="mt-2 text-sm text-muted">PNG, JPEG, or WEBP, checked from the file bytes and stored with this brand. There is no separate object store.</p>
        {logos[0] ? <img src={`data:${logos[0].mime};base64,${logos[0].body}`} alt="Stored logo" className="mt-3 h-16 w-auto" /> : <p className="mt-3 text-muted">No logo stored.</p>}
        {canEdit ? (
          <input
            className="mt-3 block"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                const raw = String(reader.result ?? "");
                const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
                void run(async () => {
                  const saved = await uploadLogo({ data: { brandId, base64 } });
                  setNote(saved.status === "stored" ? "Logo stored." : saved.detail);
                  if (saved.status === "stored") setLogos((await listBrandAssets({ data: { brandId } })).logos);
                });
              };
              reader.readAsDataURL(file);
            }}
          />
        ) : null}
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Source material</h2>
        <p className="mt-2 text-sm text-muted">Plain text, DOCX, and PDF text can be stored. Instruction-like lines are dropped. An image-only PDF fails. Nothing here overwrites the brain.</p>
        {canEdit ? (
          <form
            className="mt-3 space-y-3"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const text = String(new FormData(event.currentTarget).get("material") ?? "");
              void run(async () => {
                const saved = await storeMaterial({ data: { brandId, filename: "pasted.txt", mime: "text/plain", text, base64: "" } });
                setNote(saved.detail);
                event.currentTarget.reset();
              });
            }}
          >
            <label className="block space-y-2 text-sm font-semibold">
              Upload text, DOCX, or PDF
              <input
                className="block w-full text-sm font-normal"
                type="file"
                accept=".txt,.md,.docx,.pdf,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                aria-describedby="material-file-hint"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const raw = String(reader.result ?? "");
                    const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
                    void run(async () => {
                      const saved = await storeMaterial({ data: { brandId, filename: file.name, mime: file.type || "application/octet-stream", text: "", base64 } });
                      setNote(saved.detail);
                    });
                  };
                  reader.readAsDataURL(file);
                }}
              />
              <span id="material-file-hint" className="block font-normal text-muted">The file is stored as untrusted text. It does not change the brain.</span>
            </label>
            <TextArea name="material" aria-label="Pasted source text" placeholder="Or paste brand or product text" />
            <Button type="submit" disabled={pending}>Store pasted text</Button>
          </form>
        ) : null}
      </Panel>
      {error ? <Notice>{error}</Notice> : null}
      {note ? <p className="text-sm text-muted">{note}</p> : null}
    </div>
  );
}
