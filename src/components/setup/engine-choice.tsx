import { useState } from "react";
import { Button, DisabledReason } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { KeyForm } from "@/components/settings/setup-panel";
import { plainError } from "@/lib/copy";
import { saveDecisionEngine } from "@/lib/meridian/settings/server-actions";
import { qk } from "@/lib/query/keys";
import { useScopedMutation } from "@/lib/query/hooks";
import type { SetupEngines } from "@/components/settings/setup-model";

/** What each engine does and what it needs, in plain words. */
const ENGINE_COPY: Record<string, { summary: string; needs: string; keyCategory: "jev" | "openai" }> = {
  jev: {
    summary: "TypeSafe's grading engine. It reads each idea or ad as text and answers with a score, a yes or no, or a choice.",
    needs: "A TypeSafe key, saved for this workspace below.",
    keyCategory: "jev",
  },
  "openai-decisions": {
    summary: "The same questions, answered by an OpenAI model. It can also read images, so visual checks use the picture itself.",
    needs: "An OpenAI key, saved for this workspace below. The model is set on the server.",
    keyCategory: "openai",
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
  keys: Record<"jev" | "openai", EngineKeyState>;
}) {
  const activeId = engines.active.engineId;
  const chosen = engines.active.source !== "default";
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
  const unchanged = chosen && selected === activeId;

  return (
    <div className="space-y-4">
      {error ? <PlainErrorMessage message={error.message} raw={error.raw} /> : null}
      {message ? <p className="text-sm font-medium text-success" role="status">{message}</p> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {engines.engines.map((engine) => {
          const copy = ENGINE_COPY[engine.id];
          const ready = engine.health.status === "READY";
          const isActive = engine.id === activeId && chosen;
          const canPick = ready || isActive;
          const key = copy ? keys[copy.keyCategory] : null;
          const inputId = `engine-${engine.id}`;
          return (
            <div
              key={engine.id}
              className={`space-y-3 rounded-lg border p-4 transition duration-200 ease-out hover:shadow-md ${
                selected === engine.id ? "border-accent bg-accent-soft/60 shadow-sm" : "border-border bg-surface"
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
                    disabled={!canPick || !canAdmin || save.isPending}
                    onChange={() => { setMessage(null); setPicked(engine.id); }}
                    className="mt-1.5 size-4 shrink-0 accent-[var(--color-accent)]"
                  />
                  <label htmlFor={inputId} className={`block min-w-0 space-y-1 ${canPick && canAdmin ? "cursor-pointer" : ""}`}>
                    <span className="block font-display text-lg font-semibold text-fg">{engine.label}</span>
                    {copy ? <span className="block text-sm text-fg-muted">{copy.summary}</span> : null}
                  </label>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${ready ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>
                  {isActive ? "Active" : ready ? "Ready" : "Not ready"}
                </span>
              </div>
              {copy ? <p className="text-sm text-fg-muted"><span className="font-semibold text-fg">Needs: </span>{copy.needs}</p> : null}
              {!ready && engine.health.message ? <p className="text-sm text-warning">{engine.health.message}</p> : null}
              {/* A card that is not ready carries its key form, so the key is saved where the choice is made. */}
              {!ready && key && canAdmin ? (
                <KeyForm row={{ label: engine.label, fingerprint: key.fingerprint, removable: key.removable }} organizationId={organizationId} canAdmin={canAdmin} category={copy.keyCategory} />
              ) : null}
            </div>
          );
        })}
      </div>
      {!canAdmin ? <p className="text-sm text-fg-muted">Only a workspace admin can choose the engine or save a key. Everyone can see which one is in use.</p> : null}
      {canAdmin ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => { setMessage(null); void save.mutateAsync(selected).catch(() => undefined); }} disabled={save.isPending || unchanged || !selected} aria-describedby={unchanged ? "engine-unchanged" : undefined}>
            {save.isPending ? "Saving..." : "Use this engine"}
          </Button>
          {unchanged && !save.isPending ? <DisabledReason id="engine-unchanged">This engine is already the one in use. Pick the other card to change it.</DisabledReason> : null}
        </div>
      ) : null}
    </div>
  );
}
