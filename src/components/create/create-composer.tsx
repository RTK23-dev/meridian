import { ArrowUp } from "lucide-react";
import { MAX_MESSAGE_CHARS } from "@/lib/meridian/content-factory/model";
import { CREATE_MODE_COPY, CREATE_MODES, type CreateMode } from "./create-model";

export type ModelOption = { value: string; label: string };

/**
 * The input under the conversation, as in a chat app: one box with the text, and a row beneath it with the mode, the model and Send.
 * It sticks to the bottom of the page, so it is always in reach on a phone. The hint under it says what will happen when Send is used.
 */
export function CreateComposer({
  text,
  onText,
  mode,
  onMode,
  models,
  model,
  onModel,
  canSend,
  hint,
  busy,
  onSend,
}: {
  text: string;
  onText: (text: string) => void;
  mode: CreateMode;
  onMode: (mode: CreateMode) => void;
  models: ModelOption[];
  model: string;
  onModel: (model: string) => void;
  canSend: boolean;
  hint: string;
  busy: boolean;
  onSend: () => void;
}) {
  const studio = mode === "studio";
  return (
    <form
      aria-label="Compose"
      className="sticky bottom-0 z-10 -mx-4 bg-ground px-4 pb-4 pt-3 sm:-mx-6 sm:px-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend && !busy) onSend();
      }}
    >
      <div className="border border-border-strong bg-overlay transition-colors has-[textarea:focus-visible]:border-accent">
        <label htmlFor="create-message" className="sr-only">What should we make?</label>
        <textarea
          id="create-message"
          value={text}
          rows={2}
          maxLength={MAX_MESSAGE_CHARS}
          disabled={studio}
          aria-describedby="create-hint"
          placeholder={studio ? "Studio uses the controls on this page." : "Describe the video, the product or the reference"}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter starts a new line, as in a chat app. Not while an input method is still composing a word.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend && !busy) onSend();
            }
          }}
          className="block max-h-48 min-h-14 w-full resize-none bg-transparent px-4 pb-1 pt-3 text-body text-fg-primary placeholder:text-fg-muted focus:outline-none disabled:cursor-not-allowed disabled:text-fg-muted"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="How it runs" className="inline-flex border border-border-strong p-0.5">
              {CREATE_MODES.map((id) => {
                const active = mode === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onMode(id)}
                    className={`min-h-9 px-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${active ? "bg-raised font-semibold text-fg-primary" : "text-fg-muted hover:text-fg-primary"}`}
                  >
                    {CREATE_MODE_COPY[id].label}
                  </button>
                );
              })}
            </div>
            <label htmlFor="create-model" className="sr-only">Model</label>
            <select
              id="create-model"
              value={model}
              onChange={(event) => onModel(event.target.value)}
              className="min-h-9 border border-border-strong bg-transparent px-2 text-sm text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {models.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            aria-label={busy ? "Sending" : "Send"}
            aria-busy={busy || undefined}
            disabled={!canSend || busy}
            className="grid size-10 shrink-0 place-items-center bg-accent text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg-primary disabled:bg-raised disabled:text-fg-muted pointer-coarse:size-11"
          >
            <ArrowUp aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      <p id="create-hint" role={canSend ? undefined : "status"} className="mt-2 text-caption text-fg-muted">{hint}</p>
    </form>
  );
}
