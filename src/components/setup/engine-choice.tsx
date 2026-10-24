import { useState } from "react";
import { Button, DisabledReason } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { KeyForm } from "@/components/settings/setup-panel";
import { OpenRouterDecisionControls } from "@/components/openrouter-decision-controls";
import { plainError } from "@/lib/copy";
import { saveDecisionEngine } from "@/lib/meridian/settings/server-actions";
import { qk } from "@/lib/query/keys";
import { useScopedMutation } from "@/lib/query/hooks";
import type { SetupEngines } from "@/components/settings/setup-model";

/** What each engine does and what it needs, in plain words. */
const ENGINE_COPY: Record<string, { title: string; summary: string; needs: string; keyCategory: "jev" | "openai" | "openrouter" }> = {
  jev: {
    title: "TypeSafe JEV",
    summary: "Answers each idea or ad as text: a score, a yes or no, or a choice.",
    needs: "A TypeSafe key, saved on this card. Until that key is saved, this engine cannot be selected.",
    keyCategory: "jev",
  },
  "openai-decisions": {
    title: "OpenAI Decisions",
    summary: "The same questions, answered by an OpenAI model. It can also read images.",
    needs: "An OpenAI key, saved on this card. Until that key is saved, this engine cannot be selected.",
    keyCategory: "openai",
  },
  "openrouter-decisions": {
    title: "OpenRouter Decisions",
    summary: "The same kinds of question, answered by a decision model on OpenRouter. The verified models can also read images.",
    needs: "An OpenRouter key, saved on this card, and a passed connection test. Until the test passes, this engine cannot be chosen.",
    keyCategory: "openrouter",
  },
};

export type EngineKeyState = { fingerprint: string | null; removable: boolean };

/**
 * The decision-engine choice: two cards, each with its job, what it needs and whether it is ready. Only the picked engine
 * receives decisions, and the server refuses a switch to an engine that is not ready. A card that is not ready carries its own
 * key form, so the key is saved where the choice is made.
 */
export function EngineChoice({
  organizationId,
  canAdmin,
  engines,
  keys,
}: {
  organizationId: string;
  canAdmin: boolean;
  engines: SetupEngines;
  keys: Record<"jev" | "openai" | "openrouter", EngineKeyState>;
}) {
  const activeId = engines.active.engineId;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? activeId;
  const [message, setMessage] = useState<string | null>(null);
  const labelOf = (id: string) => engines.engines.find((engine) => engine.id === id)?.label ?? id;
  const save = useScopedMutation({
    mutationKey: ["mutation", "setup.engine.save", organizationId],
    mutationFn: async (engineId: string) => {
      const result = (await saveDecisionEngine({ data: { organizationId, engineId } })) as
        | { ok: true; engineId: string }
        | { ok: false; reason: string };
      // A refused choice is thrown, so the person sees the reason and the active engine stays as it was.
      if (!result.ok) throw new Error(`${result.reason} The active engine is unchanged.`);
      return result;
    },
    invalidate: () => [qk.decisionEngines(organizationId), qk.providerSettings(organizationId)],
    onSuccess: (result) => {
      setPicked(null);
      setMessage(`${labelOf(result.engineId)} is now the engine for this workspace. Only it receives decisions.`);
    },
  });
  const error = save.error ? plainError(save.error) : null;
  const selectedEngine = engines.engines.find((engine) => engine.id === selected);
  const selectedReady = selectedEngine?.health.status === "READY";
  const unchanged = selected === activeId && engines.active.source !== "default";

  return (
    <div className="space-y-4">
      {error ? <PlainErrorMessage message={error.message} raw={error.raw} /> : null}
      {message ? <p className="text-sm font-medium text-success" role="status">{message}</p> : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {engines.engines.map((engine) => {
          const copy = ENGINE_COPY[engine.id];
          const ready = engine.health.status === "READY";
          const isActive = engine.id === activeId && engines.active.source !== "default";
          const key = copy ? keys[copy.keyCategory] : null;
          const inputId = `engine-${engine.id}`;
          return (
            <div
              key={engine.id}
              className={`space-y-3 rounded-lg border p-4 ${
                selected === engine.id ? "border-fg bg-surface-2" : "border-border bg-surface"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <input
                    type="radio"
                    id={inputId}
                    name="decision-engine"
                    value={engine.id}
                    checked={selected === engine.id}
                    disabled={!canAdmin || save.isPending}
                    onChange={() => { setMessage(null); setPicked(engine.id); }}
                    className="mt-1.5 size-4 shrink-0 accent-[var(--color-accent)]"
                  />
                  <label htmlFor={inputId} className={`block min-w-0 space-y-1 ${canAdmin ? "cursor-pointer" : ""}`}>
                    <span className="block text-lg font-semibold text-fg">{copy?.title ?? engine.label}</span>
                    {copy ? <span className="block text-sm text-fg-muted">{copy.summary}</span> : null}
                  </label>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${ready ? "bg-success-soft text-success" : "bg-warning-soft text-fg ring-1 ring-warning/50"}`}>
                  {isActive ? "In use" : ready ? "Ready" : "Needs a key"}
                </span>
              </div>
              {copy ? <p className="text-sm text-fg-muted"><span className="font-semibold text-fg">Needs: </span>{copy.needs}</p> : null}
              {!ready && engine.health.message ? <p className="text-sm text-fg [overflow-wrap:anywhere]">{engine.health.message}</p> : null}
              {!ready && key && copy && canAdmin ? (
                <KeyForm row={{ label: copy.title, fingerprint: key.fingerprint, removable: key.removable }} organizationId={organizationId} canAdmin={canAdmin} category={copy.keyCategory} />
              ) : null}
              {engine.id === "openrouter-decisions" && engines.openrouterModel ? (
                <OpenRouterDecisionControls organizationId={organizationId} canAdmin={canAdmin} model={engines.openrouterModel} />
              ) : null}
            </div>
          );
        })}
      </div>
      {!canAdmin ? <p className="text-sm text-fg-muted">Only a workspace admin can choose the engine or save a key. Everyone can see which one is in use.</p> : null}
      {canAdmin ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={() => { setMessage(null); void save.mutateAsync(selected).catch(() => undefined); }} disabled={save.isPending || unchanged || !selected || !selectedReady} aria-describedby={!selectedReady || unchanged ? "engine-unchanged" : undefined}>
            {save.isPending ? "Saving..." : "Use this engine"}
          </Button>
          {unchanged && !save.isPending ? <DisabledReason id="engine-unchanged">This engine is already in use.</DisabledReason> : null}
          {!unchanged && !selectedReady && !save.isPending ? <DisabledReason id="engine-unchanged">Save this engine's key on its card. The choice is saved only after the key is ready.</DisabledReason> : null}
        </div>
      ) : null}
    </div>
  );
}
