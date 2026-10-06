import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BrandNav } from "@/components/brand-nav";
import { Authed, useBusy } from "@/components/gate";
import { Button, Field, Notice, Panel, SelectInput, TextArea, TextInput, errorText } from "@/components/ui";
import { hasRole } from "@/lib/meridian/access";
import {
  addCompetitor,
  fetchSourcePage,
  getMarket,
  recordObservation,
  resolveSuggestion,
  suggestFromDocument,
} from "@/lib/meridian/machine";
import { HYPOTHESES } from "@/lib/meridian/opportunity/catalog";

export const Route = createFileRoute("/brands/$brandId/market")({ component: Page });

type Market = Awaited<ReturnType<typeof getMarket>>;

function Page() {
  const { brandId } = Route.useParams();
  return (
    <Authed>
      <MarketPage brandId={brandId} />
    </Authed>
  );
}

function MarketPage({ brandId }: { brandId: string }) {
  const [market, setMarket] = useState<Market | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = useBusy();

  async function reload() {
    setMarket(await getMarket({ data: { brandId } }));
  }

  useEffect(() => {
    let cancelled = false;
    getMarket({ data: { brandId } })
      .then((next) => {
        if (!cancelled) setMarket(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  if (error) return <Notice>{error}</Notice>;
  if (!market) return <p className="text-muted">Loading market…</p>;
  const canEdit = hasRole(market.role, "member");

  return (
    <div className="space-y-8">
      <BrandNav brandId={brandId} />
      <div className="max-w-2xl space-y-3">
        <p className="text-sm font-semibold uppercase tracking-widest text-brass">Market</p>
        <h1 className="font-display text-4xl">What has actually been seen</h1>
        <p className="text-muted">
          Competitor ads are not scraped. If a source is not connected, it stays empty. Record only creatives you have seen, or fetch one public page as untrusted text.
        </p>
      </div>
      <ul className="grid gap-3 md:grid-cols-3">
        {market.adapters.map((adapter) => (
          <li key={adapter.id} className="rounded-lg border border-line bg-panel p-4">
            <p className="text-xs font-semibold uppercase tracking-widest text-brass">{adapter.implemented ? "Connected" : "Not connected"}</p>
            <h2 className="mt-2 font-display text-xl">{adapter.label}</h2>
            <p className="mt-2 text-sm text-muted">{adapter.note}</p>
          </li>
        ))}
      </ul>
      {note ? <Notice>{note}</Notice> : null}
      {busy.error ? <Notice>{busy.error}</Notice> : null}
      <Panel>
        <h2 className="font-display text-2xl">Competitors</h2>
        {market.competitors.filter((item) => item.status === "confirmed").length === 0 ? (
          <p className="mt-3 text-muted">No competitors yet. Add one you actually compete with.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {market.competitors.filter((item) => item.status === "confirmed").map((item) => (
              <li key={item.id}>
                <span className="font-semibold">{item.name}</span>
                <span className="text-muted"> · {item.kind}</span>
                {item.website ? <span className="text-muted"> · {item.website}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <form
            className="mt-4 grid gap-3 md:grid-cols-2"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void busy.run(async () => {
                await addCompetitor({
                  data: {
                    brandId,
                    name: String(form.get("name") ?? ""),
                    website: String(form.get("website") ?? ""),
                    notes: String(form.get("notes") ?? ""),
                    kind: String(form.get("kind") ?? "direct"),
                  },
                });
                event.currentTarget.reset();
                await reload();
              });
            }}
          >
            <Field label="Name">
              <TextInput name="name" required maxLength={120} />
            </Field>
            <Field label="Website" hint="Optional. Stored, not crawled.">
              <TextInput name="website" />
            </Field>
            <Field label="Kind">
              <SelectInput name="kind" defaultValue="direct">
                <option value="direct">Direct</option>
                <option value="adjacent">Adjacent</option>
                <option value="inspirational">Inspirational</option>
              </SelectInput>
            </Field>
            <div className="md:col-span-2">
              <Button type="submit" disabled={busy.pending}>Add competitor</Button>
            </div>
          </form>
        ) : null}
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Observed creatives</h2>
        <p className="mt-2 text-sm text-muted">These rows are the only competitor evidence the ranker will use.</p>
        {market.observations.length === 0 ? <p className="mt-3 text-muted">No observations stored.</p> : (
          <ul className="mt-4 space-y-3">
            {market.observations.map((item) => (
              <li key={item.id} className="border-t border-line pt-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-brass">{item.angle}</p>
                <p className="font-semibold">{item.hook}</p>
                <p className="text-sm text-muted">{item.message}</p>
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void busy.run(async () => {
                const saved = await recordObservation({
                  data: {
                    brandId,
                    origin: "competitor",
                    competitorId: String(form.get("competitorId") ?? ""),
                    angle: String(form.get("angle") ?? ""),
                    observedAngle: String(form.get("observedAngle") ?? ""),
                    hookType: String(form.get("hookType") ?? ""),
                    format: String(form.get("format") ?? ""),
                    proofType: String(form.get("proofType") ?? ""),
                    title: String(form.get("title") ?? ""),
                    hook: String(form.get("hook") ?? ""),
                    message: String(form.get("message") ?? ""),
                    offer: String(form.get("offer") ?? ""),
                    cta: String(form.get("cta") ?? ""),
                    claim: String(form.get("claim") ?? ""),
                    platform: String(form.get("platform") ?? ""),
                    productName: "",
                    sourceUrl: String(form.get("sourceUrl") ?? ""),
                  },
                });
                setNote(saved.duplicate ? "That observation was already stored." : "Observation stored.");
                if (!saved.duplicate) event.currentTarget.reset();
                await reload();
              });
            }}
          >
            <Field label="Competitor">
              <SelectInput name="competitorId" required defaultValue="">
                <option value="" disabled>Choose</option>
                {market.competitors.filter((item) => item.status === "confirmed").map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Angle preset">
              <SelectInput name="angle" defaultValue="demonstration">
                <option value="">Not in the list</option>
                {HYPOTHESES.map((item) => (
                  <option key={item.id} value={item.angle}>{item.label}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Observed angle, if it is not in the list">
              <TextInput name="observedAngle" placeholder="unboxing" />
            </Field>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Hook type"><TextInput name="hookType" placeholder="defaults from the preset" /></Field>
              <Field label="Format"><TextInput name="format" placeholder="short_ugc" /></Field>
              <Field label="Proof"><TextInput name="proofType" placeholder="demonstration" /></Field>
            </div>
            <Field label="Hook">
              <TextInput name="hook" required maxLength={400} />
            </Field>
            <Field label="What the creative says">
              <TextArea name="message" required />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Offer"><TextInput name="offer" /></Field>
              <Field label="Call to action"><TextInput name="cta" /></Field>
              <Field label="Claim you saw"><TextInput name="claim" /></Field>
              <Field label="Platform"><TextInput name="platform" /></Field>
              <Field label="Source URL"><TextInput name="sourceUrl" /></Field>
            </div>
            <Button type="submit" disabled={busy.pending}>Store observation</Button>
          </form>
        ) : null}
      </Panel>
      <Panel>
        <h2 className="font-display text-2xl">Public page</h2>
        <p className="mt-2 text-sm text-muted">The text is stored as untrusted data. It does not change the brand brain unless you accept a suggestion.</p>
        {canEdit ? (
          <form
            className="mt-4 flex flex-wrap gap-3"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void busy.run(async () => {
                const result = await fetchSourcePage({ data: { brandId, url: String(form.get("url") ?? "") } });
                setNote(result.status === "stored" ? "Page text stored. It is not part of the brand brain." : result.error);
                await reload();
              });
            }}
          >
            <TextInput name="url" placeholder="https://" className="max-w-md" required />
            <Button type="submit" disabled={busy.pending}>Fetch page</Button>
          </form>
        ) : null}
        <ul className="mt-4 space-y-3">
          {market.documents.length === 0 ? <li className="text-muted">No pages stored.</li> : market.documents.map((doc) => (
            <li key={doc.id} className="border-t border-line pt-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-brass">{doc.status}</p>
              <p className="break-all text-sm">{doc.url}</p>
              {doc.error ? <p className="text-sm text-danger">{doc.error}</p> : <p className="text-sm text-muted">{doc.excerpt}</p>}
              {canEdit && doc.status === "stored" ? (
                <Button
                  className="mt-2"
                  variant="quiet"
                  disabled={busy.pending}
                  onClick={() => {
                    void busy.run(async () => {
                      const result = await suggestFromDocument({ data: { brandId, documentId: doc.id } });
                      setNote(result.message);
                      await reload();
                    });
                  }}
                >
                  Suggest brain edits
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {market.suggestions.length > 0 ? (
          <div className="mt-6 space-y-3">
            <h3 className="font-display text-xl">Suggestions waiting</h3>
            {market.suggestions.map((item) => (
              <div key={item.id} className="rounded-md border border-line p-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-brass">{item.field}</p>
                <p className="mt-1">{item.value}</p>
                {canEdit ? (
                  <div className="mt-3 flex gap-2">
                    <Button
                      disabled={busy.pending}
                      onClick={() => void busy.run(async () => {
                        await resolveSuggestion({ data: { brandId, suggestionId: item.id, action: "accept" } });
                        await reload();
                      })}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={busy.pending}
                      onClick={() => void busy.run(async () => {
                        await resolveSuggestion({ data: { brandId, suggestionId: item.id, action: "dismiss" } });
                        await reload();
                      })}
                    >
                      Dismiss
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
