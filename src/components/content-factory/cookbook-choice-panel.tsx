// The cookbook step in the draft panel (round 3, K18c). It asks the server for the cookbooks proposed for this run (the run's inputs are read on
// the server from the session), draws them with CookbookSelectionStep, and sends the person's choice. A choice is recorded on the draft run only.
// While a pick or the picker is on screen and nothing is chosen, the panel tells the draft panel that a choice is needed, so the start waits.

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/components/workspace";
import { toast } from "@/components/ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { chooseCookbookForRunAction, proposeCookbookForRunAction } from "@/lib/meridian/cookbooks/actions";
import type { ControlValue } from "@/lib/meridian/cookbooks/controls";
import type { CookbookRef } from "@/lib/meridian/cookbooks/selector";
import { selectionViewOf, type ChoiceToSend, type SelectionView } from "./cookbook-selection-model";
import { CookbookSelectionStep } from "./cookbook-selection-step";
import { CookbookSettingsStep } from "./cookbook-settings-step";

type Loaded = { state: "loading" } | { state: "unavailable"; reason: string } | { state: "ready"; view: SelectionView };

export function CookbookChoicePanel({ sessionId, onChoiceNeededChange }: { sessionId: string; onChoiceNeededChange: (needed: boolean) => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The settings the person has on screen, for the cookbook they are on. They are sent with the confirm.
  const [settings, setSettings] = useState<{ cookbookId: string; values: Record<string, ControlValue> } | null>(null);
  const reportValues = useCallback((cookbookId: string, values: Record<string, ControlValue>) => setSettings({ cookbookId, values }), []);
  const workspace = useWorkspace();
  const user = useCurrentUserState().user;

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
            if (view.state !== "pick") return;
            const values = settings?.cookbookId === view.confirm.cookbookId ? settings.values : view.confirm.values;
            void send({ ...view.confirm, values }, view.title);
          }}
          onPick={(cookbook: CookbookRef) => void send({ cookbookId: cookbook.cookbookId, version: cookbook.version, values: {} }, cookbook.label)}
        />
        {view.state === "pick" ? (
          <CookbookSettingsStep
            userId={user?.id ?? "signed-out"}
            workspaceId={workspace.data?.active?.id ?? "no-workspace"}
            cookbookId={view.confirm.cookbookId}
            controls={view.controls}
            base={view.confirm.values}
            onValues={reportValues}
          />
        ) : null}
      </div>
    </section>
  );
}
