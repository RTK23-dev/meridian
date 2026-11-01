// The cookbook step in the draft panel (round 3, K18c). It asks the server for the cookbooks proposed for this run (the run's inputs are read on
// the server from the session), draws them with CookbookSelectionStep, and sends the person's choice. A choice is recorded on the draft run only.
// While a pick or the picker is on screen and nothing is chosen, the panel tells the draft panel that a choice is needed, so the start waits.

import { useEffect, useState } from "react";
import { toast } from "@/components/ui";
import { chooseCookbookForRunAction, proposeCookbookForRunAction } from "@/lib/meridian/cookbooks/actions";
import type { CookbookRef } from "@/lib/meridian/cookbooks/selector";
import { selectionViewOf, type ChoiceToSend, type SelectionView } from "./cookbook-selection-model";
import { CookbookSelectionStep } from "./cookbook-selection-step";

type Loaded = { state: "loading" } | { state: "unavailable"; reason: string } | { state: "ready"; view: SelectionView };

export function CookbookChoicePanel({ sessionId, onChoiceNeededChange }: { sessionId: string; onChoiceNeededChange: (needed: boolean) => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded({ state: "loading" });
    setChosen(null);
    setError(null);
    (async () => {
      try {
        const outcome = await proposeCookbookForRunAction({ data: { sessionId } });
        if (cancelled) return;
        setLoaded(outcome.ok ? { state: "ready", view: selectionViewOf(outcome.value) } : { state: "unavailable", reason: outcome.reason });
      } catch (caught) {
        if (!cancelled) setLoaded({ state: "unavailable", reason: caught instanceof Error ? caught.message : "The cookbooks could not be read." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // A pick or the picker needs a choice until one is recorded; nothing else does.
  const needed = loaded.state === "ready" && (loaded.view.state === "pick" || loaded.view.state === "picker") && chosen === null;
  useEffect(() => {
    onChoiceNeededChange(needed);
  }, [needed, onChoiceNeededChange]);

  const send = async (choice: ChoiceToSend, label: string) => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await chooseCookbookForRunAction({ data: { sessionId, cookbookId: choice.cookbookId, version: choice.version, values: choice.values } });
      if (outcome.ok) {
        setChosen(label);
        toast.success(`Cookbook chosen: ${label}.`);
      } else {
        setError(outcome.reason);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The cookbook was not chosen.");
    } finally {
      setBusy(false);
    }
  };

  if (loaded.state === "loading") return <p className="mb-4 text-sm text-fg-muted">Reading the cookbooks for this video…</p>;
  if (loaded.state === "unavailable") return <p className="mb-4 text-sm text-fg-muted">No cookbook yet: {loaded.reason}</p>;

  const view = loaded.view;
  return (
    <section aria-labelledby="cf-cookbook" className="mb-4 space-y-3 rounded-md border border-border p-3">
      <h2 id="cf-cookbook" className="text-sm font-semibold">Cookbook</h2>
      {chosen !== null ? <p className="text-sm">Chosen: {chosen}. You can change it below until the video starts.</p> : null}
      {error !== null ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <div aria-busy={busy}>
        <CookbookSelectionStep
          view={view}
          onConfirm={() => {
            if (view.state === "pick") void send(view.confirm, view.title);
          }}
          onPick={(cookbook: CookbookRef) => void send({ cookbookId: cookbook.cookbookId, version: cookbook.version, values: {} }, cookbook.label)}
        />
      </div>
    </section>
  );
}
