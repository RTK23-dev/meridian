import { useState } from "react";
import { GeminiDecisionControls } from "@/components/gemini-decision-controls";
import { Button, DisabledReason } from "@/components/ui";
import { PlainErrorMessage } from "@/components/plain-error";
import { KeyForm } from "@/components/settings/setup-panel";
import { OpenRouterDecisionControls } from "@/components/openrouter-decision-controls";
import { plainError } from "@/lib/copy";
import { saveDecisionEngine } from "@/lib/meridian/settings/server-actions";
import { qk } from "@/lib/query/keys";
import { useScopedMutation } from "@/lib/query/hooks";
import type { SetupEngines } from "@/components/settings/setup-model";
import { openRouterProgress, savedKeyEngineProgress, type EngineProgress } from "@/components/setup/engine-progress";
import { splitOperatorHint } from "@/components/settings/key-copy";
import { DISABLED_CAPABILITIES, type DisabledCapability } from "@/lib/meridian/providers/capability";

/** What each engine does and what it needs, in plain words. */
const ENGINE_COPY: Record<string, { title: string; summary: string; needs: string; keyCategory: "jev" | "openai" | "openrouter" | "perception"; keyLink?: { href: string; label: string }; off?: DisabledCapability }> = {
  jev: {
    title: "TypeSafe JEV",
    summary: "Answers each idea or ad as text: a score, a yes or no, or a choice.",
    needs: "A TypeSafe key, saved on this card. Until that key is saved, this engine cannot be selected.",
    keyCategory: "jev",
    off: "decision.typesafe_jev",
  },
  "openai-decisions": {
    title: "OpenAI Decisions",
    summary: "The same questions, answered by an OpenAI model. It can also read images.",
    needs: "An OpenAI key, saved on this card. Until that key is saved, this engine cannot be selected.",
    keyCategory: "openai",
    off: "decision.openai",
  },
  "gemini-decisions": {
    title: "Gemini Decisions",
    summary: "Google's Gemini judges your ideas as text. You choose the model from Google's own live list, and the newest is marked.",
    needs: "A Gemini key, saved on this card (the same key Perception and Production use), and a model chosen from Google's list.",
    keyCategory: "perception",
    keyLink: { href: "https://aistudio.google.com/apikey", label: "Get a Gemini key" },
  },
  "openrouter-decisions": {
    title: "OpenRouter Decisions",
    summary: "The same kinds of question, answered by a decision model on OpenRouter. The verified models can also read images.",
    needs: "An OpenRouter key, saved on this card, and a passed connection test. Until the test passes, this engine cannot be chosen.",
    keyCategory: "openrouter",
    keyLink: { href: "https://openrouter.ai/keys", label: "Get an OpenRouter key" },
  },
};

/** The order the engines are offered in: the one most people should pick first. */
const ORDER = ["openrouter-decisions", "gemini-decisions", "jev", "openai-decisions"];
const RECOMMENDED = "openrouter-decisions";

/** An engine whose live calls are switched off in this version and that is not working now. It is listed, not offered. */
function switchedOff(engine: { id: string; health: { status: string } }): boolean {
  const off = ENGINE_COPY[engine.id]?.off;
  return off !== undefined && off in DISABLED_CAPABILITIES && engine.health.status !== "READY";
}

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
  keys: Record<"jev" | "openai" | "openrouter" | "perception", EngineKeyState>;
}) {
  const activeId = engines.active.engineId;
  const [picked, setPicked] = useState<string | null>(null);
  const sorted = [...engines.engines].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const offered = sorted.filter((engine) => !switchedOff(engine));
  const unavailable = sorted.filter(switchedOff);
  // The engine in use is shown selected, unless it is one that cannot work in this version: then the recommended one is.
  const activeOffered = offered.some((engine) => engine.id === activeId);
  const selected = picked ?? (activeOffered ? activeId : (offered.find((engine) => engine.id === RECOMMENDED) ?? offered[0])?.id ?? activeId);
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
        {offered.map((engine) => {
          const copy = ENGINE_COPY[engine.id];
          const ready = engine.health.status === "READY";
          // The engine receiving decisions right now, whether it was chosen for this workspace or is the default.
          const isActive = engine.id === activeId;
          const isDefault = isActive && engines.active.source === "default";
          const key = copy ? keys[copy.keyCategory] : null;
          const inputId = `engine-${engine.id}`;
          return (
            <div
              key={engine.id}
              // The chosen engine takes the full row and shows its details. The others stay one short row each, so the step stays short.
              className={`rounded-sharp border p-4 ${
                selected === engine.id ? "space-y-3 border-fg-primary bg-overlay md:col-span-2" : "space-y-1 border-hairline bg-raised"
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
                    className="mt-1.5 size-4 shrink-0 accent-[var(--accent)]"
                  />
                  <label htmlFor={inputId} className={`block min-w-0 space-y-1 ${canAdmin ? "cursor-pointer" : ""}`}>
                    <span className="block text-lg font-semibold text-fg-primary">{copy?.title ?? engine.label}{engine.id === RECOMMENDED ? <span className="ml-2 align-middle text-xs font-semibold text-fg-muted">Recommended</span> : null}</span>
                    {copy && selected === engine.id ? <span className="block text-sm text-fg-muted">{copy.summary}</span> : null}
                  </label>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${ready ? "bg-raised text-success" : "bg-raised text-fg-primary ring-1 ring-warning/50"}`}>
                  {isActive ? (ready ? (isDefault ? "In use (default)" : "In use") : "Chosen, not ready") : ready ? "Ready" : key && key.fingerprint === null ? "Needs a key" : "Needs setup"}
                </span>
              </div>
              {selected === engine.id ? (
                <div className="space-y-3">
              {copy ? <p className="text-sm text-fg-muted"><span className="font-semibold text-fg-primary">Needs: </span>{copy.needs}</p> : null}
              {!ready && copy?.keyLink && key && key.fingerprint === null ? <p className="text-sm"><a className="font-semibold underline" href={copy.keyLink.href} target="_blank" rel="noreferrer">{copy.keyLink.label}</a><span className="text-fg-muted"> (opens their site), then paste it below.</span></p> : null}
              {!ready && engine.health.message ? <EngineReason message={engine.health.message} /> : null}
              {engine.id === "gemini-decisions" && key && key.fingerprint !== null ? <GeminiDecisionControls organizationId={organizationId} canAdmin={canAdmin} /> : null}
              {!ready && key && copy && canAdmin ? (
                <KeyForm row={{ label: copy.title, fingerprint: key.fingerprint, removable: key.removable }} organizationId={organizationId} canAdmin={canAdmin} category={copy.keyCategory} />
              ) : null}
              {engine.id === "openrouter-decisions" ? <EngineSteps label="OpenRouter" progress={openRouterProgress({ keySaved: keys.openrouter.fingerprint !== null, testPassed: ready, active: isActive, activeLabel: labelOf(activeId) })} /> : null}
              {copy && engine.id !== "openrouter-decisions" && key ? <EngineSteps label={copy.title} progress={savedKeyEngineProgress({ engineLabel: copy.title, keySaved: key.fingerprint !== null, ready, active: isActive, activeLabel: labelOf(activeId) })} /> : null}
              {engine.id === "openrouter-decisions" && engines.openrouterModel ? (
                <OpenRouterDecisionControls organizationId={organizationId} canAdmin={canAdmin} model={engines.openrouterModel} />
              ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {unavailable.length > 0 ? (
        <p className="text-sm text-fg-muted">
          Not available in this version: {unavailable.map((engine) => ENGINE_COPY[engine.id]?.title ?? engine.label).join(" and ")}.
          {!activeOffered ? " The workspace starts on one of them, so pick an engine above." : ""}
        </p>
      ) : null}
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

/** Key saved, test passed and engine active, as three separate steps with the one next action. */
function EngineSteps({ label, progress }: { label: string; progress: EngineProgress }) {
  return (
    <div className="space-y-2 rounded-sharp bg-overlay p-3" aria-label={`${label} setup progress`}>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {progress.steps.map((step) => (
          <li key={step.id} className={step.done ? "font-semibold text-success" : "text-fg-muted"}>
            <span aria-hidden="true">{step.done ? "\u2713 " : "\u25CB "}</span>
            {step.label}
            <span className="sr-only">{step.done ? " (done)" : " (not yet)"}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm text-fg-primary">{progress.next}</p>
    </div>
  );
}

/** The engine's reason in plain words, with the server variable names for whoever runs the server kept out of the way. */
function EngineReason({ message }: { message: string }) {
  const reason = splitOperatorHint(message);
  return (
    <div className="space-y-1">
      <p className="text-sm text-fg-primary [overflow-wrap:anywhere]">{reason.plain}</p>
      {reason.operator ? (
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer">For whoever runs the server</summary>
          <p className="mt-1 font-mono [overflow-wrap:anywhere]">{reason.operator}</p>
        </details>
      ) : null}
    </div>
  );
}
