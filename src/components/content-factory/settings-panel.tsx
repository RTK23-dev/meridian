import { useState } from "react";
import { Button, Card, CardDescription, CardHeader, CardTitle, Checkbox, Input, SelectInput, toast } from "@/components/ui";
import { saveContentFactorySettings } from "@/lib/meridian/content-factory/actions";
import { GENE_LABELS, KEEPABLE_GENES, MAX_SECONDS, MIN_SECONDS, PRIORITIES, type KeepableGene, type SessionDetail } from "@/lib/meridian/content-factory/model";

type BrandOption = { id: string; name: string };

/** What the person sets for the video. Every field starts empty: nothing is defaulted, and the run panel names what is still missing. */
export function SettingsPanel({ session, brands, hasFiles, onSaved }: { session: SessionDetail; brands: BrandOption[]; hasFiles: boolean; onSaved: () => void }) {
  const settings = session.settings;
  const [brandId, setBrandId] = useState(session.brandId ?? "");
  const [budget, setBudget] = useState(settings.budgetUsd === null ? "" : String(settings.budgetUsd));
  const [length, setLength] = useState(settings.maxSeconds === null ? "" : String(settings.maxSeconds));
  const [language, setLanguage] = useState(settings.language ?? "");
  const [priority, setPriority] = useState(settings.priority ?? "");
  const [keep, setKeep] = useState<KeepableGene[]>(settings.keepGenes);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await saveContentFactorySettings({
        data: {
          sessionId: session.id,
          ...(hasFiles ? {} : { brandId: brandId || null }),
          budgetUsd: budget === "" ? null : Number(budget),
          maxSeconds: length === "" ? null : Number(length),
          language: language || null,
          priority: priority || null,
          keepGenes: keep,
        },
      });
      toast.success("Video settings saved.");
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The settings were not saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Video settings</CardTitle>
        <CardDescription>The engine makes vertical 9:16 video. You set the budget of every video; no default is used.</CardDescription>
      </CardHeader>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="space-y-1.5">
          <label htmlFor="cf-brand" className="block text-sm font-semibold">Brand</label>
          <SelectInput id="cf-brand" value={brandId} disabled={hasFiles} aria-describedby={hasFiles ? "cf-brand-reason" : undefined} onChange={(event) => setBrandId(event.target.value)}>
            <option value="">No brand</option>
            {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </SelectInput>
          {hasFiles ? <p id="cf-brand-reason" className="text-sm text-fg-muted">Files are kept under this brand, so the brand cannot change now.</p> : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Budget (USD)" type="number" min="0.01" max="1000" step="0.01" inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} hint="The most the engine may spend on this video." />
          <Input label="Length (seconds)" type="number" min={MIN_SECONDS} max={MAX_SECONDS} step="1" inputMode="numeric" value={length} onChange={(event) => setLength(event.target.value)} hint={`From ${MIN_SECONDS} to ${MAX_SECONDS} seconds.`} />
          <Input label="Language of your script lines" value={language} onChange={(event) => setLanguage(event.target.value)} placeholder="en" hint="Only when you write script lines, as a code such as en or es-MX. Otherwise the engine chooses." />
          <div className="space-y-1.5">
            <label htmlFor="cf-priority" className="block text-sm font-semibold">Priority</label>
            <SelectInput id="cf-priority" value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="">Not set</option>
              {PRIORITIES.map((item) => <option key={item} value={item}>{item}</option>)}
            </SelectInput>
          </div>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Keep from the reference</legend>
          <p className="text-sm text-fg-muted">Structure, pacing and style carry over. The reference's footage, words, voice and music never do.</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {KEEPABLE_GENES.map((gene) => (
              <Checkbox
                key={gene}
                label={GENE_LABELS[gene]}
                checked={keep.includes(gene)}
                onCheckedChange={(checked) => setKeep((current) => (checked === true ? [...new Set([...current, gene])] : current.filter((item) => item !== gene)))}
              />
            ))}
          </div>
        </fieldset>
        <Button type="submit" size="md" variant="secondary" loading={busy}>Save settings</Button>
      </form>
    </Card>
  );
}
